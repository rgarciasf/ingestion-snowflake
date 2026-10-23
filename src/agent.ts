// The agent, shared by both versions (Revenue and HR). Claude Opus 5.5 plans and investigates with governed
// Snowflake tools; a Claude Sonnet 5.5 verifier independently re-derives every number before anything is
// written back; writes wait for a human Approve click.
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { query, assertReadOnly, sqlLiteral, type Rows } from "./snowflake.ts";
import { EDITIONS, AS_OF, type EditionId } from "./editions.ts";

const MAIN_MODEL = process.env.MAIN_MODEL || "claude-opus-5-5";
const VERIFIER_MODEL = process.env.VERIFIER_MODEL || "claude-sonnet-5-5";
const PREVIEW_ROWS = 40;

const client = new Anthropic();

export type AgentEvent =
  | { type: "status"; text: string }
  | { type: "tool_start"; id: string; tool: string; input: unknown; agent: "main" | "verifier" }
  | { type: "tool_end"; id: string; tool: string; summary: string; ref?: string; error?: boolean; agent: "main" | "verifier" }
  | { type: "approval"; approvalId: string; edition: EditionId; items: ProposedItem[] }
  | { type: "approval_result"; approvalId: string; approved: boolean; written: number }
  | { type: "answer"; text: string }
  | { type: "done"; traceId: string; refs: Record<string, Ref>; usage: { input: number; output: number }; ms: number }
  | { type: "error"; text: string };

// Everything the answer cites: SQL results (q1, q2...) and document chunks (chunk ids).
export type Ref =
  | { kind: "sql"; id: string; sql: string; purpose: string; rows: Rows; rowCount: number; ms: number }
  | { kind: "chunk"; id: string; title: string; text: string; account?: string; team?: string };

// Revenue: a risk alert for an account. HR: a retention plan for a team.
type Action = { owner: string; action: string; due_date: string; category?: string };
type ProposedItem = {
  workspace_id?: number; account?: string; arr_usd?: number; renewal_date?: string;
  team?: string;
  risk_level: "high" | "medium" | "low";
  summary: string;
  evidence: string[];
  actions: Action[];
};

// ------------------------------------------------------------------------------------------ approvals
const pendingApprovals = new Map<string, (approved: boolean, approver: string) => void>();
export function resolveApproval(id: string, approved: boolean, approver: string): boolean {
  const resolve = pendingApprovals.get(id);
  if (!resolve) return false;
  pendingApprovals.delete(id);
  resolve(approved, approver);
  return true;
}

// ------------------------------------------------------------------------------------------ prompts
function systemPrompt(edition: EditionId, role: string) {
  const e = EDITIONS[edition];
  const p = e.personas[role];
  return `You are Ingestion, Acme's company-brain agent (${e.product}, ${e.label} version), working for the ${p.label} (Snowflake role ${role}: ${p.description}).
${e.mission}

${e.schemaGuide}

How you work:
1. Investigate with tools. Every number you state must come from a run_sql result; cite it as [q1], [q2]... Every claim from a document or note must cite its chunk id in brackets, e.g. [people-2026-10-05-data-infra-retro--1].
2. Before proposing any actions, call verify_numbers with the key figures you will rely on. Do not propose items whose numbers failed verification; fix them first.
3. propose_actions pauses for human approval and writes to Snowflake only if approved.
4. You only see what the ${role} role can see in Snowflake (row access, masking and aggregation policies). If data seems missing or masked, say so plainly; never guess.
Be concise. Use Markdown.`;
}

// ------------------------------------------------------------------------------------------ tools
const RUN_SQL: Anthropic.Tool = {
  name: "run_sql",
  description: "Run one read-only Snowflake SQL query (SELECT/WITH/SHOW/DESCRIBE) under the persona's role. Returns up to 40 rows and a reference id (q1, q2, ...) to cite.",
  input_schema: {
    type: "object",
    properties: {
      sql: { type: "string", description: "A single Snowflake SQL statement" },
      purpose: { type: "string", description: "One short sentence: what this query answers" },
    },
    required: ["sql", "purpose"],
  },
};

const VERIFY: Anthropic.Tool = {
  name: "verify_numbers",
  description: "Independent verification: a separate verifier agent re-derives each claim from Snowflake with its own SQL and reports pass/fail. Use before proposing actions.",
  input_schema: {
    type: "object",
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          properties: {
            claim: { type: "string", description: "e.g. 'Data Infra after-hours hours per person per week rose 190% vs the prior 8 weeks'" },
            value: { type: "string", description: "The number as you will state it" },
          },
          required: ["claim", "value"],
        },
      },
    },
    required: ["claims"],
  },
};

const ACTION_ITEMS = {
  type: "array",
  items: {
    type: "object",
    properties: {
      owner: { type: "string" },
      action: { type: "string" },
      due_date: { type: "string", description: "YYYY-MM-DD" },
      category: { type: "string", enum: ["workload", "recovery", "career", "pay", "staffing", "follow_up", "other"] },
    },
    required: ["owner", "action", "due_date", "category"],
  },
};

function toolsFor(edition: EditionId): Anthropic.Tool[] {
  const revenue = edition === "revenue";
  return [
    RUN_SQL,
    {
      name: "search_knowledge",
      description: revenue
        ? "Hybrid search (Cortex Search) over Acme documents, support tickets and customer meeting transcripts. Returns chunks with ids to cite."
        : "Hybrid search (Cortex Search) over Acme policies and HR notes (1:1s, team retros, staffing reviews). Returns chunks with ids to cite.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          ...(revenue
            ? { account: { type: "string", description: "Optional exact customer account name, e.g. 'Kestrel Bank'" } }
            : { team: { type: "string", description: "Optional exact team name, e.g. 'Data Infra'" } }),
          source_type: { type: "string", enum: revenue ? ["meetings", "support", "product", "docs", "policies", "faqs", "tools"] : ["people", "policies", "tools"] },
          limit: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["query"],
      },
    },
    {
      name: "get_commitments",
      description: revenue
        ? "List promises Acme made to customers in meetings (owner, due date, status, quote, citation chunk). Overdue = not done and due before today."
        : "List promises made to employees and teams (owner, promised to, category, due date, status open/done/broken, quote, citation chunk). Overdue = not done and due before today.",
      input_schema: {
        type: "object",
        properties: {
          ...(revenue ? { account: { type: "string" } } : { team: { type: "string" } }),
          overdue_only: { type: "boolean" },
        },
      },
    },
    {
      name: "explore_graph",
      description: "Walk Acme's knowledge graph (teams, people, services, incidents, customers and how they relate) from one entity, in both directions. Use it for ownership, dependency and impact questions, e.g. 'if Lena Okafor is out, which services and customers are exposed?'. Cite results with the returned [q#].",
      input_schema: {
        type: "object",
        properties: {
          entity: { type: "string", description: "Entity name or alias, e.g. 'Lena Okafor', 'Ingest Service', 'DI-4410', 'Kestrel Bank', 'Data Infra Team'" },
          hops: { type: "integer", minimum: 1, maximum: 3, description: "How far to walk (default 2)" },
        },
        required: ["entity"],
      },
    },
    VERIFY,
    {
      name: "propose_actions",
      description: revenue
        ? "Propose revenue-at-risk alerts with owned actions. Shows an approval card; on approval they are written to ACME.BRAIN.RISK_ALERTS."
        : "Propose team retention plans with owned actions. Shows an approval card to the HRBP; on approval they are written to ACME.BRAIN.PEOPLE_ACTIONS. Pay-affecting actions (category pay) are routed to Total Rewards.",
      input_schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: revenue
              ? {
                  type: "object",
                  properties: {
                    workspace_id: { type: "integer" },
                    account: { type: "string" },
                    arr_usd: { type: "number" },
                    renewal_date: { type: "string", description: "YYYY-MM-DD" },
                    risk_level: { type: "string", enum: ["high", "medium", "low"] },
                    summary: { type: "string", description: "Two sentences: why this account is at risk" },
                    evidence: { type: "array", items: { type: "string" }, description: "Verified facts, each with its [q#] or [chunk] citation" },
                    actions: ACTION_ITEMS,
                  },
                  required: ["workspace_id", "account", "arr_usd", "renewal_date", "risk_level", "summary", "evidence", "actions"],
                }
              : {
                  type: "object",
                  properties: {
                    team: { type: "string" },
                    risk_level: { type: "string", enum: ["high", "medium", "low"] },
                    summary: { type: "string", description: "Two sentences: why this team is at risk (team level, no individual profiling)" },
                    evidence: { type: "array", items: { type: "string" }, description: "Verified facts, each with its [q#] or [chunk] citation" },
                    actions: ACTION_ITEMS,
                  },
                  required: ["team", "risk_level", "summary", "evidence", "actions"],
                },
          },
        },
        required: ["items"],
      },
    },
  ];
}

// ------------------------------------------------------------------------------------------ run state
type Run = {
  edition: EditionId;
  role: string;
  refs: Record<string, Ref>;
  qCount: number;
  emit: (e: AgentEvent) => void;
  usage: { input: number; output: number };
  steps: unknown[];
};

const jsonReplacer = (_k: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v instanceof Date ? v.toISOString().slice(0, 10) : v);

async function runSql(run: Run, sql: string, purpose: string): Promise<{ text: string; ref: string; summary: string }> {
  const safe = assertReadOnly(sql);
  const limited = /^\s*(show|describe|desc)\b/i.test(safe) ? safe : `SELECT * FROM (${safe}) LIMIT 1000`;
  const t0 = Date.now();
  const rows = await query(run.role, limited);
  const id = `q${++run.qCount}`;
  run.refs[id] = { kind: "sql", id, sql: safe, purpose, rows: rows.slice(0, 200), rowCount: rows.length, ms: Date.now() - t0 };
  const preview = rows.slice(0, PREVIEW_ROWS);
  const more = rows.length > PREVIEW_ROWS ? `\n(${rows.length - PREVIEW_ROWS} more rows not shown; aggregate in SQL instead)` : "";
  return {
    ref: id,
    summary: `${rows.length} row${rows.length === 1 ? "" : "s"} · ${Date.now() - t0} ms`,
    text: `Result ${id} (${rows.length} rows):\n${JSON.stringify(preview, jsonReplacer)}${more}`,
  };
}

// Ask Snowflake (under the persona's role) which of these accounts / teams the role may see.
async function visible(run: Run, kind: "account" | "team", names: string[]): Promise<Set<string>> {
  if (!names.length) return new Set();
  const sql = kind === "account"
    ? `SELECT DISTINCT NAME AS N FROM ACME.PULSE.WORKSPACES WHERE NAME IN (${names.map(sqlLiteral).join(",")})`
    : `SELECT DISTINCT TEAM AS N FROM ACME.PEOPLE.EMPLOYEES WHERE TEAM IN (${names.map(sqlLiteral).join(",")})`;
  return new Set((await query(run.role, sql)).map((r) => String(r.N)));
}

async function searchKnowledge(run: Run, input: { query: string; account?: string; team?: string; source_type?: string; limit?: number }) {
  const persona = EDITIONS[run.edition].personas[run.role];
  // Document access levels mirror DOC_ACCESS_POLICY on ACME.KNOWLEDGE.DOCUMENTS.
  const filters: object[] = [{ "@or": persona.docAccess.map((a) => ({ "@eq": { ACCESS: a } })) }];
  if (input.account) filters.push({ "@eq": { ACCOUNT: input.account } });
  if (input.team) filters.push({ "@eq": { TEAM: input.team } });
  if (input.source_type) filters.push({ "@eq": { SOURCE_TYPE: input.source_type } });
  const request = {
    query: input.query,
    columns: ["CHUNK_ID", "CHUNK_TEXT", "TITLE", "SOURCE_TYPE", "ACCOUNT", "TEAM", "STATUS", "UPDATED_ON"],
    limit: input.limit ?? 6,
    filter: { "@and": filters },
  };
  const rows = await query(
    run.role,
    `SELECT SNOWFLAKE.CORTEX.SEARCH_PREVIEW('ACME.KNOWLEDGE.KNOWLEDGE_SEARCH', ${sqlLiteral(JSON.stringify(request))}) AS R`,
  );
  const raw = rows[0]?.R;
  let results = ((typeof raw === "string" ? JSON.parse(raw) : raw) as { results?: Record<string, string>[] })?.results ?? [];
  // Customer documents follow the account's region entitlement; team documents follow the team entitlement.
  // Each version only sees its own kind of scoped document.
  const scopeKey = run.edition === "revenue" ? "ACCOUNT" : "TEAM";
  const otherKey = run.edition === "revenue" ? "TEAM" : "ACCOUNT";
  const before = results.length;
  results = results.filter((r) => !r[otherKey]);
  const names = [...new Set(results.map((r) => r[scopeKey]).filter(Boolean))];
  const allowed = await visible(run, run.edition === "revenue" ? "account" : "team", names);
  results = results.filter((r) => !r[scopeKey] || allowed.has(r[scopeKey]));
  const hidden = before - results.length;
  for (const r of results) run.refs[r.CHUNK_ID] = { kind: "chunk", id: r.CHUNK_ID, title: r.TITLE, text: r.CHUNK_TEXT, account: r.ACCOUNT, team: r.TEAM };
  const body = results
    .map((r) => `[${r.CHUNK_ID}] ${r.TITLE}${r.STATUS === "superseded" ? " (SUPERSEDED)" : ""} · ${r.UPDATED_ON ?? ""}\n${r.CHUNK_TEXT}`)
    .join("\n\n---\n\n");
  return {
    summary: `${results.length} chunks${hidden ? ` · ${hidden} withheld by access rules` : ""}`,
    text: (body || "No matching documents.") + (hidden ? `\n\n(${hidden} result(s) outside this role's access were withheld.)` : ""),
  };
}

async function exploreGraph(run: Run, input: { entity: string; hops?: number }) {
  const hops = Math.min(3, Math.max(1, input.hops ?? 2));
  const sql = `WITH RECURSIVE seed_entity AS (
  SELECT NAME FROM ACME.KNOWLEDGE.KG_ENTITIES
  WHERE LOWER(NAME) = LOWER(${sqlLiteral(input.entity)}) OR ARRAY_CONTAINS(LOWER(${sqlLiteral(input.entity)})::VARIANT, ALIASES)
  LIMIT 1
), edges AS (
  SELECT FROM_ENTITY AS src, TO_ENTITY AS dst, FROM_ENTITY, PREDICATE, TO_ENTITY, CONTEXT FROM ACME.KNOWLEDGE.KG_RELATIONS
  UNION ALL
  SELECT TO_ENTITY, FROM_ENTITY, FROM_ENTITY, PREDICATE, TO_ENTITY, CONTEXT FROM ACME.KNOWLEDGE.KG_RELATIONS
), walk AS (
  SELECT NAME AS node, 0 AS hop, NULL::STRING AS f, NULL::STRING AS p, NULL::STRING AS t, NULL::STRING AS c, ARRAY_CONSTRUCT(NAME) AS seen FROM seed_entity
  UNION ALL
  SELECT e.dst, w.hop + 1, e.FROM_ENTITY, e.PREDICATE, e.TO_ENTITY, e.CONTEXT, ARRAY_APPEND(w.seen, e.dst)
  FROM walk w JOIN edges e ON e.src = w.node
  WHERE w.hop < ${hops} AND NOT ARRAY_CONTAINS(e.dst::VARIANT, w.seen)
)
SELECT DISTINCT w.hop AS HOP, w.f AS FROM_ENTITY, fe.TYPE AS FROM_TYPE, w.p AS PREDICATE, w.t AS TO_ENTITY, te.TYPE AS TO_TYPE, w.c AS CONTEXT
FROM walk w
LEFT JOIN ACME.KNOWLEDGE.KG_ENTITIES fe ON fe.NAME = w.f
LEFT JOIN ACME.KNOWLEDGE.KG_ENTITIES te ON te.NAME = w.t
WHERE w.hop > 0 ORDER BY HOP, FROM_ENTITY LIMIT 150`;
  let rows = await query(run.role, sql);
  // Customer nodes follow the same region entitlement as customer data in the Revenue version.
  let hidden = 0;
  if (run.edition === "revenue") {
    const customers = [...new Set(rows.flatMap((r) => [r.FROM_TYPE === "CUSTOMER" ? r.FROM_ENTITY : null, r.TO_TYPE === "CUSTOMER" ? r.TO_ENTITY : null]).filter(Boolean) as string[])];
    const allowed = await visible(run, "account", customers);
    const before = rows.length;
    rows = rows.filter((r) => (r.FROM_TYPE !== "CUSTOMER" || allowed.has(String(r.FROM_ENTITY))) && (r.TO_TYPE !== "CUSTOMER" || allowed.has(String(r.TO_ENTITY))));
    hidden = before - rows.length;
  }
  const id = `q${++run.qCount}`;
  run.refs[id] = { kind: "sql", id, sql, purpose: `Knowledge graph around ${input.entity}`, rows, rowCount: rows.length, ms: 0 };
  if (!rows.length) return { ref: id, summary: "no matching entity", text: `No graph entity matches "${input.entity}".` };
  const lines = rows.map((r) => `hop ${r.HOP}: ${r.FROM_ENTITY} -${r.PREDICATE}-> ${r.TO_ENTITY}${r.CONTEXT ? ` (${r.CONTEXT})` : ""}`);
  return {
    ref: id,
    summary: `${rows.length} relations · ${hops} hops${hidden ? ` · ${hidden} hidden by region policy` : ""}`,
    text: `Result ${id} (cite as [${id}]):\n${lines.join("\n")}`,
  };
}

async function getCommitments(run: Run, input: { account?: string; team?: string; overdue_only?: boolean }) {
  const revenue = run.edition === "revenue";
  const notDone = revenue ? "STATUS <> 'done'" : "STATUS IN ('open', 'broken', 'unknown')";
  const where = [
    revenue && input.account ? `ACCOUNT = ${sqlLiteral(input.account)}` : "TRUE",
    !revenue && input.team ? `TEAM = ${sqlLiteral(input.team)}` : "TRUE",
    input.overdue_only ? `${notDone} AND DUE_DATE < '${AS_OF}'` : "TRUE",
  ].join(" AND ");
  const sql = revenue
    ? `SELECT ACCOUNT, OWNER, COMMITMENT, MEETING_DATE, DUE_DATE, STATUS, STATUS_EVIDENCE, IFF(${notDone} AND DUE_DATE < '${AS_OF}', TRUE, FALSE) AS OVERDUE, QUOTE, CHUNK_ID
FROM ACME.BRAIN.COMMITMENTS WHERE ${where} ORDER BY ACCOUNT, DUE_DATE`
    : `SELECT TEAM, PROMISED_TO, OWNER, COMMITMENT, CATEGORY, MEETING_DATE, DUE_DATE, STATUS, STATUS_EVIDENCE, IFF(${notDone} AND DUE_DATE < '${AS_OF}', TRUE, FALSE) AS OVERDUE, QUOTE, CHUNK_ID
FROM ACME.BRAIN.PEOPLE_COMMITMENTS WHERE ${where} ORDER BY TEAM, DUE_DATE`;
  const rows = await query(run.role, sql);
  const id = `q${++run.qCount}`;
  run.refs[id] = { kind: "sql", id, sql, purpose: revenue ? "Customer commitments from meetings" : "Promises to employees and teams", rows, rowCount: rows.length, ms: 0 };
  // Make the cited chunks openable in the UI (DOC_CHUNKS is readable by every persona; access is re-checked by search).
  const chunkIds = [...new Set(rows.map((r) => r.CHUNK_ID as string).filter(Boolean))];
  if (chunkIds.length) {
    const chunks = await query(run.role, `SELECT CHUNK_ID, TITLE, CHUNK_TEXT, ACCOUNT, TEAM FROM ACME.KNOWLEDGE.DOC_CHUNKS WHERE CHUNK_ID IN (${chunkIds.map(sqlLiteral).join(",")})`);
    for (const c of chunks) run.refs[c.CHUNK_ID as string] = { kind: "chunk", id: c.CHUNK_ID as string, title: c.TITLE as string, text: c.CHUNK_TEXT as string, account: c.ACCOUNT as string, team: c.TEAM as string };
  }
  const overdue = rows.filter((r) => r.OVERDUE).length;
  return { ref: id, summary: `${rows.length} commitments · ${overdue} overdue`, text: `Result ${id}:\n${JSON.stringify(rows, jsonReplacer)}` };
}

async function verifyNumbers(run: Run, claims: { claim: string; value: string }[]) {
  const system = `You are an independent verifier for Acme. For each claim, write your own Snowflake SQL with run_sql to re-derive the number from scratch (do not trust the claim's wording about how it was computed). Today is ${AS_OF}.
${EDITIONS[run.edition].schemaGuide}
Then reply with ONLY a JSON array: [{"claim": "...", "stated": "...", "found": "...", "verdict": "pass" | "fail", "ref": "q#", "note": "..."}]. A claim passes if your number matches within normal rounding (about 2%).`;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: JSON.stringify(claims, null, 2) }];
  for (let turn = 0; turn < 12; turn++) {
    const res = await client.messages.create({
      model: VERIFIER_MODEL,
      max_tokens: 16000,
      system,
      tools: [RUN_SQL],
      output_config: { effort: "medium" },
      messages,
    });
    run.usage.input += res.usage.input_tokens;
    run.usage.output += res.usage.output_tokens;
    if (res.stop_reason !== "tool_use") {
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      const verdicts = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as { verdict: string }[];
      const failed = verdicts.filter((v) => v.verdict !== "pass").length;
      return { summary: `${verdicts.length - failed}/${verdicts.length} verified${failed ? ` · ${failed} failed` : ""}`, text: JSON.stringify(verdicts) };
    }
    messages.push({ role: "assistant", content: res.content });
    messages.push({ role: "user", content: await runTools(run, res.content, "verifier") });
  }
  throw new Error("Verifier did not finish");
}

async function proposeActions(run: Run, items: ProposedItem[]) {
  const approvalId = randomUUID();
  const decision = new Promise<{ approved: boolean; approver: string }>((resolve) =>
    pendingApprovals.set(approvalId, (approved, approver) => resolve({ approved, approver })),
  );
  run.emit({ type: "approval", approvalId, edition: run.edition, items });
  const timeout = new Promise<{ approved: boolean; approver: string }>((resolve) =>
    setTimeout(() => resolve({ approved: false, approver: "timeout" }), 5 * 60_000),
  );
  const { approved, approver } = await Promise.race([decision, timeout]);
  pendingApprovals.delete(approvalId);
  if (!approved) {
    run.emit({ type: "approval_result", approvalId, approved: false, written: 0 });
    return { summary: "declined by user", text: "The user declined. Nothing was written. Do not propose again in this run." };
  }
  for (const a of items) {
    if (run.edition === "revenue") {
      await query(
        run.role,
        `INSERT INTO ACME.BRAIN.RISK_ALERTS (WORKSPACE_ID, ACCOUNT, ARR_USD, RENEWAL_DATE, RISK_LEVEL, SUMMARY, EVIDENCE, ACTIONS, APPROVED_BY)
         SELECT ?, ?, ?, ?, ?, ?, PARSE_JSON(?), PARSE_JSON(?), ?`,
        [a.workspace_id ?? null, a.account ?? null, a.arr_usd ?? null, a.renewal_date ?? null, a.risk_level, a.summary, JSON.stringify(a.evidence), JSON.stringify(a.actions), approver],
      );
    } else {
      // Pay-affecting steps never execute here: they are routed to Total Rewards for a separate approval.
      const needsTotalRewards = a.actions.some((x) => x.category === "pay");
      await query(
        run.role,
        `INSERT INTO ACME.BRAIN.PEOPLE_ACTIONS (TEAM, RISK_LEVEL, SUMMARY, EVIDENCE, ACTIONS, REQUIRES_APPROVAL_FROM, STATUS, APPROVED_BY)
         SELECT ?, ?, ?, PARSE_JSON(?), PARSE_JSON(?), ?, ?, ?`,
        [a.team ?? null, a.risk_level, a.summary, JSON.stringify(a.evidence), JSON.stringify(a.actions), needsTotalRewards ? "Total Rewards" : null, needsTotalRewards ? "pending Total Rewards" : "open", approver],
      );
    }
  }
  run.emit({ type: "approval_result", approvalId, approved: true, written: items.length });
  const table = run.edition === "revenue" ? "ACME.BRAIN.RISK_ALERTS" : "ACME.BRAIN.PEOPLE_ACTIONS";
  return { summary: `approved · ${items.length} written`, text: `Approved by ${approver}. ${items.length} item(s) written to ${table}.` };
}

async function executeTool(run: Run, name: string, input: any): Promise<{ text: string; summary: string; ref?: string }> {
  switch (name) {
    case "run_sql": return runSql(run, input.sql, input.purpose ?? "");
    case "search_knowledge": return searchKnowledge(run, input);
    case "get_commitments": return getCommitments(run, input);
    case "explore_graph": return exploreGraph(run, input);
    case "verify_numbers": return verifyNumbers(run, input.claims ?? []);
    case "propose_actions": return proposeActions(run, input.items ?? []);
    default: throw new Error(`Unknown tool ${name}`);
  }
}

async function runTools(run: Run, content: Anthropic.ContentBlock[], agent: "main" | "verifier"): Promise<Anthropic.ToolResultBlockParam[]> {
  const uses = content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  return Promise.all(
    uses.map(async (u) => {
      run.emit({ type: "tool_start", id: u.id, tool: u.name, input: u.input, agent });
      try {
        const r = await executeTool(run, u.name, u.input);
        run.emit({ type: "tool_end", id: u.id, tool: u.name, summary: r.summary, ref: r.ref, agent });
        run.steps.push({ agent, tool: u.name, input: u.input, summary: r.summary, ref: r.ref });
        return { type: "tool_result" as const, tool_use_id: u.id, content: r.text };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        run.emit({ type: "tool_end", id: u.id, tool: u.name, summary: msg, error: true, agent });
        run.steps.push({ agent, tool: u.name, input: u.input, error: msg });
        return { type: "tool_result" as const, tool_use_id: u.id, content: `Error: ${msg}`, is_error: true };
      }
    }),
  );
}

// ------------------------------------------------------------------------------------------ main loop
export async function ask(question: string, edition: EditionId, role: string, emit: (e: AgentEvent) => void) {
  const traceId = randomUUID();
  const t0 = Date.now();
  const run: Run = { edition, role, refs: {}, qCount: 0, emit, usage: { input: 0, output: 0 }, steps: [] };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: question }];
  const tools = toolsFor(edition);
  let answer = "";
  try {
    for (let turn = 0; turn < 30; turn++) {
      emit({ type: "status", text: turn === 0 ? "Planning…" : "Thinking…" });
      const res = (await client.beta.messages.create({
        model: MAIN_MODEL,
        max_tokens: 16000,
        system: systemPrompt(edition, role),
        tools,
        output_config: { effort: "high" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages,
      } as any)) as Anthropic.Message;
      run.usage.input += res.usage.input_tokens;
      run.usage.output += res.usage.output_tokens;
      if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason === "tool_use") {
        messages.push({ role: "user", content: await runTools(run, res.content, "main") });
        continue;
      }
      if (res.stop_reason === "pause_turn") continue;
      answer = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
      emit({ type: "answer", text: answer });
      break;
    }
  } catch (err) {
    emit({ type: "error", text: err instanceof Error ? err.message : String(err) });
  }
  const ms = Date.now() - t0;
  emit({ type: "done", traceId, refs: run.refs, usage: run.usage, ms });
  // Audit trail in Snowflake (best effort).
  query(
    role,
    `INSERT INTO ACME.BRAIN.AGENT_TRACES (TRACE_ID, ROLE_NAME, QUESTION, ANSWER, STEPS, MODEL, INPUT_TOKENS, OUTPUT_TOKENS, LATENCY_MS)
     SELECT ?, ?, ?, ?, PARSE_JSON(?), ?, ?, ?, ?`,
    [traceId, role, `[${edition}] ${question}`, answer, JSON.stringify(run.steps), MAIN_MODEL, run.usage.input, run.usage.output, ms],
  ).catch((e) => console.error("trace insert failed:", e.message));
}
