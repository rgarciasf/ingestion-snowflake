// HTTP server: the web UI, a streaming /api/ask endpoint (newline-delimited JSON events),
// the approval endpoint, and read endpoints for each version's table and actions tabs.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { ask, resolveApproval } from "./agent.ts";
import { query } from "./snowflake.ts";
import { EDITIONS, ENABLED, isEdition, personaOf } from "./editions.ts";

const PORT = Number(process.env.PORT || 3000);
const WEB = new URL("../web/", import.meta.url);

const bigint = (_k: string, v: unknown) => (typeof v === "bigint" ? Number(v) : v);

async function body(req: IncomingMessage): Promise<any> {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value, bigint));
}

// Public version config for the UI (no SQL or prompts).
const publicEditions = Object.fromEntries(
  Object.values(EDITIONS).filter((e) => ENABLED.includes(e.id)).map((e) => [e.id, {
    id: e.id, label: e.label, product: e.product, headline: e.headline, subtitle: e.subtitle, examples: e.examples,
    personas: Object.fromEntries(Object.entries(e.personas).map(([k, p]) => [k, { label: p.label, description: p.description }])),
    tableTab: { label: e.tableTab.label, title: e.tableTab.title, subtitle: e.tableTab.subtitle },
    actionsTab: { label: e.actionsTab.label, title: e.actionsTab.title, subtitle: e.actionsTab.subtitle },
  }]),
);

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await readFile(new URL("index.html", WEB)));
    }
    if (req.method === "GET" && url.pathname === "/logo.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml" });
      return res.end(await readFile(new URL("logo.svg", WEB)));
    }
    if (req.method === "GET" && url.pathname === "/api/editions") return json(res, 200, publicEditions);

    if (req.method === "POST" && url.pathname === "/api/ask") {
      const { question, edition, role } = await body(req);
      if (!question || !isEdition(edition) || !personaOf(edition, role)) return json(res, 400, { error: "question, edition and a valid role are required" });
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
      await ask(String(question), edition, role, (e) => res.write(JSON.stringify(e, bigint) + "\n"));
      return res.end();
    }

    if (req.method === "POST" && url.pathname === "/api/approve") {
      const { approvalId, approved, approver } = await body(req);
      const ok = resolveApproval(String(approvalId), Boolean(approved), String(approver || "demo user"));
      return json(res, ok ? 200 : 404, { ok });
    }

    if (req.method === "GET" && (url.pathname === "/api/table" || url.pathname === "/api/actions")) {
      const edition = url.searchParams.get("edition");
      const role = url.searchParams.get("role") ?? "";
      if (!isEdition(edition) || !personaOf(edition, role)) return json(res, 400, { error: "edition and role required" });
      const tab = url.pathname === "/api/table" ? EDITIONS[edition].tableTab : EDITIONS[edition].actionsTab;
      return json(res, 200, await query(role, tab.sql));
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  }
}).listen(PORT, () => console.log(`Ingestion x Snowflake running on http://localhost:${PORT}`));
