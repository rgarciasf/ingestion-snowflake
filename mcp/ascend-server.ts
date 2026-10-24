// Ascend MCP server: exposes Ascend HR data (performance reviews, goals, feedback) as a few fixed,
// aggregate-only tools. SignalHR's agent connects to it over stdio; Claude Desktop can use it too.
//
// Modes (ASCEND_MODE):
// - "standin" (default): an in-process Postgres (PGlite) with Ascend's table layout, loaded with the same
//   fictional Acme people as Snowflake (parsed from snowflake/hr/1x_*.sql). No real data anywhere.
// - "live": the real Ascend Postgres via ASCEND_DATABASE_URL, read-only session. Never used for the demo.
//
// Privacy by construction, in both modes:
// - Tools are fixed queries; there is no free-SQL tool.
// - Every result is GROUP BY team; groups with fewer than 5 people are dropped (HAVING).
// - No names, emails, ids or free text are ever returned.
// - ASCEND_SCOPE_TEAM (set by the app from the persona, never by the model) limits results to one team.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync } from "node:fs";

const K = 5;
const MODE = process.env.ASCEND_MODE === "live" ? "live" : "standin";
const SCOPE = process.env.ASCEND_SCOPE_TEAM || null;
const ORG = "org_acme";

type Db = { query: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]> };

// ------------------------------------------------------------------------------------------ stand-in data
// Parses the VALUES rows of one INSERT INTO <table> statement in a seed file.
function seedRows(file: string, table: string): unknown[][] {
  const text = readFileSync(new URL(`../snowflake/hr/${file}`, import.meta.url), "utf8");
  const start = text.indexOf(`INSERT INTO ${table} VALUES`);
  if (start < 0) throw new Error(`${table} not found in ${file}`);
  const body = text.slice(start, text.indexOf(";\n", start));
  return body.split("\n").filter((l) => l.startsWith("(")).map(parseTuple);
}

function parseTuple(line: string): unknown[] {
  const out: unknown[] = [];
  const s = line.trim().replace(/,$/, "").slice(1, -1);
  let i = 0;
  while (i < s.length) {
    while (s[i] === " " || s[i] === ",") i++;
    if (s[i] === "'") {
      let v = "";
      i++;
      while (i < s.length) {
        if (s[i] === "'" && s[i + 1] === "'") { v += "'"; i += 2; continue; }
        if (s[i] === "'") { i++; break; }
        v += s[i++];
      }
      out.push(v);
    } else {
      let j = i;
      while (j < s.length && s[j] !== ",") j++;
      const tok = s.slice(i, j).trim();
      out.push(tok === "NULL" ? null : tok === "TRUE" ? true : tok === "FALSE" ? false : Number(tok));
      i = j;
    }
  }
  return out;
}

async function standinDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE organizations (id text PRIMARY KEY, name text);
    CREATE TABLE teams (id text PRIMARY KEY, "organizationId" text, name text, department text);
    CREATE TABLE memberships (id text PRIMARY KEY, "organizationId" text, "teamId" text, "managerId" text,
      status text, role text, level text, "startDate" date);
    CREATE TABLE review_cycles (id text PRIMARY KEY, "organizationId" text, name text, status text, "endDate" date);
    CREATE TABLE reviews (id text PRIMARY KEY, "cycleId" text, "subjectId" text, type text, status text,
      "overallRating" numeric, "calibratedRating" numeric);
    CREATE TABLE review_template_questions (id text PRIMARY KEY, category text);
    CREATE TABLE review_responses (id serial PRIMARY KEY, "reviewId" text, "questionId" text, "ratingValue" numeric);
    CREATE TABLE goals (id text PRIMARY KEY, "organizationId" text, "ownerId" text, status text, timeframe text,
      progress numeric, "keyResults" int);
    CREATE TABLE feedbacks (id text PRIMARY KEY, "organizationId" text, "senderId" text, "receiverId" text,
      type text, visibility text, "isAnonymous" boolean, "createdAt" date);
    INSERT INTO organizations VALUES ('${ORG}', 'Acme (fictional)');`);

  const ins = async (table: string, rows: unknown[][]) => {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const width = chunk[0].length;
      const params = chunk.flat();
      const values = chunk.map((_, r) => `(${Array.from({ length: width }, (_, c) => `$${r * width + c + 1}`).join(",")})`).join(",");
      await pg.query(`INSERT INTO ${table} VALUES ${values}`, params);
    }
  };

  // TEAMS: TEAM_ID, TEAM, DEPARTMENT, ...
  const teams = seedRows("10_hr_seed.sql", "TEAMS");
  const teamId = new Map(teams.map((t) => [t[1] as string, `team_${t[0]}`]));
  await ins("teams", teams.map((t) => [`team_${t[0]}`, ORG, t[1], t[2]]));

  // EMPLOYEES: EMPLOYEE_ID, NAME, TEAM, DEPARTMENT, MANAGER, REGION, LOCATION_TIER, LEVEL, TITLE, HIRE_DATE, ..., STATUS (14)
  const emps = seedRows("10_hr_seed.sql", "EMPLOYEES");
  const idByName = new Map(emps.map((e) => [e[1] as string, `m_${e[0]}`]));
  await ins("memberships", emps.map((e) => [
    `m_${e[0]}`, ORG, teamId.get(e[2] as string) ?? null, idByName.get(e[4] as string) ?? null,
    e[14] === "active" ? "ACTIVE" : "INACTIVE", /^(M\d|VP)/.test(e[7] as string) ? "MANAGER" : "MEMBER", e[7], e[9],
  ]));

  // REVIEWS: REVIEW_ID, SUBJECT_ID, TEAM, CYCLE, CYCLE_END, REVIEW_TYPE, AUTHOR, STATUS, OVERALL_RATING
  const reviews = seedRows("11_hr_performance.sql", "REVIEWS");
  const cycles = new Map<string, string>();
  for (const r of reviews) cycles.set(r[3] as string, r[4] as string);
  await ins("review_cycles", [...cycles].map(([name, end]) => [`cyc_${name}`, ORG, name, "COMPLETED", end]));
  await ins("reviews", reviews.map((r) => [`rev_${r[0]}`, `cyc_${r[3]}`, `m_${r[1]}`, r[5], r[7], r[8], r[8]]));

  // REVIEW_RATINGS: REVIEW_ID, SUBJECT_ID, TEAM, CYCLE, COMPETENCY, RATING
  const ratings = seedRows("11_hr_performance.sql", "REVIEW_RATINGS");
  const cats = [...new Set(ratings.map((r) => r[4] as string))];
  await ins("review_template_questions", cats.map((c, i) => [`q_${i + 1}`, c]));
  await ins("review_responses", ratings.map((r, i) => [i + 1, `rev_${r[0]}`, `q_${cats.indexOf(r[4] as string) + 1}`, r[5]]));

  // GOALS: GOAL_ID, OWNER_ID, TEAM, TIMEFRAME, YEAR, PROGRESS, STATUS, KEY_RESULTS
  const goals = seedRows("11_hr_performance.sql", "GOALS");
  await ins("goals", goals.map((g) => [`goal_${g[0]}`, ORG, `m_${g[1]}`, g[6], g[3], g[5], g[7]]));

  // FEEDBACK: FEEDBACK_ID, SENDER_ID, RECEIVER_ID, TEAM, FEEDBACK_TYPE, VISIBILITY, CREATED_AT
  const fb = seedRows("11_hr_performance.sql", "FEEDBACK");
  await ins("feedbacks", fb.map((f) => [`fb_${f[0]}`, ORG, `m_${f[1]}`, `m_${f[2]}`, f[4], f[5], false, f[6]]));

  return { query: async (sql, params = []) => (await pg.query(sql, params)).rows as Record<string, unknown>[] };
}

async function liveDb(): Promise<Db> {
  if (!process.env.ASCEND_DATABASE_URL) throw new Error("ASCEND_MODE=live needs ASCEND_DATABASE_URL");
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: process.env.ASCEND_DATABASE_URL });
  await c.connect();
  await c.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  return { query: async (sql, params = []) => (await c.query(sql, params)).rows };
}

const db = MODE === "live" ? await liveDb() : await standinDb();
const ORG_ID = MODE === "live" ? process.env.ASCEND_ORG_ID ?? "" : ORG;

// ------------------------------------------------------------------------------------------ tools
// Team filter: the persona scope (from the app) always wins over the model's optional team argument.
function teamFilter(arg: string | undefined, params: unknown[]) {
  const team = SCOPE ?? arg;
  if (!team) return "";
  params.push(team);
  return ` AND t.name = $${params.length}`;
}

function result(sql: string, rows: Record<string, unknown>[], note?: string) {
  const payload = {
    source: MODE === "live" ? "Ascend (live, read-only)" : "Ascend (synthetic stand-in, fictional Acme data)",
    scope: SCOPE ? `team ${SCOPE} only` : "all teams",
    min_group_size: K,
    ...(note ? { note } : {}),
    rows,
    sql: sql.replace(/\s+/g, " ").trim(),
  };
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

const server = new McpServer({ name: "ascend", version: "0.1.0" });

server.registerTool(
  "review_cycles",
  { description: "List Ascend performance review cycles with status, end date and number of reviews.", inputSchema: {} },
  async () => {
    const sql = `SELECT c.name AS cycle, c.status, c."endDate"::text AS end_date, COUNT(r.id)::int AS reviews
      FROM review_cycles c LEFT JOIN reviews r ON r."cycleId" = c.id
      WHERE c."organizationId" = $1 GROUP BY 1, 2, 3 ORDER BY 3`;
    return result(sql, await db.query(sql, [ORG_ID]));
  },
);

server.registerTool(
  "team_review_summary",
  {
    description: "Per team for one review cycle: people reviewed, manager and self review completion %, average manager rating, share rated 5, and average self-minus-manager gap. Teams with fewer than 5 people are suppressed.",
    inputSchema: { cycle: z.string().optional().describe("Cycle name, e.g. 2026-H1. Defaults to the latest."), team: z.string().optional() },
  },
  async ({ cycle, team }) => {
    const params: unknown[] = [ORG_ID];
    const cyc = cycle
      ? (params.push(cycle), `c.name = $${params.length}`)
      : `c.id = (SELECT id FROM review_cycles WHERE "organizationId" = $1 ORDER BY "endDate" DESC LIMIT 1)`;
    const tf = teamFilter(team, params);
    const sql = `WITH r AS (
        SELECT t.name AS team, c.name AS cycle, rv."subjectId", rv.type, rv.status, COALESCE(rv."calibratedRating", rv."overallRating") AS rating
        FROM reviews rv JOIN review_cycles c ON c.id = rv."cycleId" JOIN memberships m ON m.id = rv."subjectId" JOIN teams t ON t.id = m."teamId"
        WHERE c."organizationId" = $1 AND ${cyc}${tf})
      , gap AS (
        SELECT team, "subjectId", MAX(rating) FILTER (WHERE type = 'SELF_ASSESSMENT') - MAX(rating) FILTER (WHERE type = 'MANAGER_REVIEW') AS gap
        FROM r GROUP BY team, "subjectId")
      SELECT r.team, MIN(r.cycle) AS cycle, COUNT(DISTINCT r."subjectId")::int AS people,
        ROUND(100.0 * COUNT(*) FILTER (WHERE type = 'MANAGER_REVIEW' AND status = 'SUBMITTED') / NULLIF(COUNT(*) FILTER (WHERE type = 'MANAGER_REVIEW'), 0), 1) AS manager_completion_pct,
        ROUND(100.0 * COUNT(*) FILTER (WHERE type = 'SELF_ASSESSMENT' AND status = 'SUBMITTED') / NULLIF(COUNT(*) FILTER (WHERE type = 'SELF_ASSESSMENT'), 0), 1) AS self_completion_pct,
        ROUND(AVG(rating) FILTER (WHERE type = 'MANAGER_REVIEW'), 2) AS avg_manager_rating,
        ROUND(100.0 * COUNT(*) FILTER (WHERE type = 'MANAGER_REVIEW' AND rating = 5) / NULLIF(COUNT(*) FILTER (WHERE type = 'MANAGER_REVIEW' AND rating IS NOT NULL), 0), 1) AS pct_rated_5,
        (SELECT ROUND(AVG(g.gap), 2) FROM gap g WHERE g.team = r.team) AS avg_self_minus_manager
      FROM r GROUP BY r.team HAVING COUNT(DISTINCT r."subjectId") >= ${K} ORDER BY r.team`;
    return result(sql, await db.query(sql, params));
  },
);

server.registerTool(
  "goal_progress",
  {
    description: "Per team: number of goals, average progress %, share at risk and share completed. Teams with fewer than 5 goal owners are suppressed.",
    inputSchema: { team: z.string().optional() },
  },
  async ({ team }) => {
    const params: unknown[] = [ORG_ID];
    const tf = teamFilter(team, params);
    const sql = `SELECT t.name AS team, COUNT(*)::int AS goals, ROUND(AVG(g.progress), 1) AS avg_progress_pct,
        ROUND(100.0 * COUNT(*) FILTER (WHERE g.status = 'AT_RISK') / COUNT(*), 1) AS pct_at_risk,
        ROUND(100.0 * COUNT(*) FILTER (WHERE g.status = 'COMPLETED') / COUNT(*), 1) AS pct_completed
      FROM goals g JOIN memberships m ON m.id = g."ownerId" JOIN teams t ON t.id = m."teamId"
      WHERE g."organizationId" = $1${tf}
      GROUP BY t.name HAVING COUNT(DISTINCT g."ownerId") >= ${K} ORDER BY avg_progress_pct`;
    return result(sql, await db.query(sql, params));
  },
);

server.registerTool(
  "feedback_activity",
  {
    description: "Per team: peer feedback received (count and per person) and the share that is praise, over the last N months. Content is never returned. Teams with fewer than 5 receivers are suppressed.",
    inputSchema: { months: z.number().int().min(1).max(24).optional().describe("Default 6"), team: z.string().optional() },
  },
  async ({ months, team }) => {
    const params: unknown[] = [ORG_ID, months ?? 6];
    const tf = teamFilter(team, params);
    const sql = `SELECT t.name AS team, COUNT(*)::int AS feedback_count,
        ROUND(COUNT(*)::numeric / COUNT(DISTINCT f."receiverId"), 2) AS per_receiver,
        ROUND(100.0 * COUNT(*) FILTER (WHERE f.type = 'PRAISE') / COUNT(*), 1) AS pct_praise
      FROM feedbacks f JOIN memberships m ON m.id = f."receiverId" JOIN teams t ON t.id = m."teamId"
      WHERE f."organizationId" = $1 AND f."createdAt" >= DATE '2026-10-22' - make_interval(months => $2::int)${tf}
      GROUP BY t.name HAVING COUNT(DISTINCT f."receiverId") >= ${K} ORDER BY per_receiver`;
    return result(sql, await db.query(sql, params));
  },
);

server.registerTool(
  "competency_scores",
  {
    description: "Per team and competency: average manager rating for one review cycle. Teams with fewer than 5 rated people are suppressed.",
    inputSchema: { cycle: z.string().optional().describe("Defaults to the latest"), team: z.string().optional() },
  },
  async ({ cycle, team }) => {
    const params: unknown[] = [ORG_ID];
    const cyc = cycle
      ? (params.push(cycle), `c.name = $${params.length}`)
      : `c.id = (SELECT id FROM review_cycles WHERE "organizationId" = $1 ORDER BY "endDate" DESC LIMIT 1)`;
    const tf = teamFilter(team, params);
    const sql = `SELECT t.name AS team, q.category AS competency, ROUND(AVG(rr."ratingValue"), 2) AS avg_rating
      FROM review_responses rr JOIN reviews rv ON rv.id = rr."reviewId" JOIN review_cycles c ON c.id = rv."cycleId"
      JOIN review_template_questions q ON q.id = rr."questionId" JOIN memberships m ON m.id = rv."subjectId" JOIN teams t ON t.id = m."teamId"
      WHERE c."organizationId" = $1 AND ${cyc}${tf}
      GROUP BY 1, 2 HAVING COUNT(DISTINCT rv."subjectId") >= ${K} ORDER BY 1, 2`;
    return result(sql, await db.query(sql, params));
  },
);

await server.connect(new StdioServerTransport());
console.error(`ascend MCP server ready (${MODE}${SCOPE ? `, scope ${SCOPE}` : ""})`);
