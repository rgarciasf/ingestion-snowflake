// MCP client for the Ascend HR server (mcp/ascend-server.ts). One stdio connection per Snowflake role, so
// the persona's team scope is set by the app when the server starts, never by the model.
// Ascend tools are offered to Claude as ascend_<tool>; if the server can't start, the agent runs without them.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type Anthropic from "@anthropic-ai/sdk";

const PREFIX = "ascend_";
const SERVER = new URL("../mcp/ascend-server.ts", import.meta.url).pathname;
// Persona scope: managers see only their own team, as in Snowflake's TEAM_POLICY.
const SCOPE: Record<string, string> = { ACME_MGR_DATA_INFRA: "Data Infra" };

type Conn = { client: Client; tools: Anthropic.Tool[] };
const conns = new Map<string, Promise<Conn | null>>();

function connect(role: string): Promise<Conn | null> {
  if (!conns.has(role)) {
    conns.set(role, (async () => {
      try {
        const env: Record<string, string> = { ...(process.env as Record<string, string>), ASCEND_MODE: process.env.ASCEND_MODE ?? "standin" };
        delete env.ASCEND_SCOPE_TEAM;
        if (SCOPE[role]) env.ASCEND_SCOPE_TEAM = SCOPE[role];
        const client = new Client({ name: "signalhr", version: "0.1.0" });
        await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "ignore" }));
        const { tools } = await client.listTools();
        return {
          client,
          tools: tools.map((t) => ({
            name: PREFIX + t.name,
            description: `[Ascend HR system via MCP] ${t.description ?? ""}`,
            input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
          })),
        };
      } catch (err) {
        console.error("Ascend MCP unavailable:", err instanceof Error ? err.message : err);
        conns.delete(role);
        return null;
      }
    })());
  }
  return conns.get(role)!;
}

export const isAscendTool = (name: string) => name.startsWith(PREFIX);

export async function ascendTools(role: string): Promise<Anthropic.Tool[]> {
  return (await connect(role))?.tools ?? [];
}

export async function callAscend(role: string, name: string, input: unknown) {
  const conn = await connect(role);
  if (!conn) throw new Error("Ascend MCP server is not available");
  const res = await conn.client.callTool({ name: name.slice(PREFIX.length), arguments: (input ?? {}) as Record<string, unknown> });
  const text = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
  if (res.isError) throw new Error(text);
  return JSON.parse(text) as { source: string; scope: string; rows: Record<string, unknown>[]; sql: string };
}
