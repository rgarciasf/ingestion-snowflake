// Snowflake access. One connection per persona role, so every query the agent runs is governed
// by that role's grants and row access policies (enforced by Snowflake, not by this app).
import snowflake from "snowflake-sdk";

snowflake.configure({ logLevel: "ERROR" });

const connections = new Map<string, Promise<snowflake.Connection>>();

function connect(role: string): Promise<snowflake.Connection> {
  let conn = connections.get(role);
  if (!conn) {
    const c = snowflake.createConnection({
      account: required("SNOWFLAKE_ACCOUNT"),
      username: required("SNOWFLAKE_USER"),
      password: required("SNOWFLAKE_PASSWORD"),
      warehouse: process.env.SNOWFLAKE_WAREHOUSE || "ACME_WH",
      database: "ACME",
      role,
      clientSessionKeepAlive: true,
    });
    // Only the persona's role may be active: hackathon users have DEFAULT_SECONDARY_ROLES = ALL, which would
    // also activate ACCOUNTADMIN and every other granted role and silently bypass the row access policies.
    conn = c.connectAsync().then(
      () => new Promise<snowflake.Connection>((resolve, reject) =>
        c.execute({ sqlText: "USE SECONDARY ROLES NONE", complete: (err) => (err ? reject(err) : resolve(c)) }),
      ),
    );
    conn.catch(() => connections.delete(role));
    connections.set(role, conn);
  }
  return conn;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.example)`);
  return v;
}

export type Rows = Record<string, unknown>[];

export async function query(role: string, sqlText: string, binds: (string | number | null)[] = []): Promise<Rows> {
  const conn = await connect(role);
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText,
      binds: binds as snowflake.Binds,
      complete: (err, _stmt, rows) => (err ? reject(err) : resolve((rows ?? []) as Rows)),
    });
  });
}

// The agent may only read. Writes go through dedicated, approval-gated functions below.
const READ_ONLY = /^\s*(with|select|show|describe|desc)\b/i;
const FORBIDDEN = /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|call|put|get|copy|use|execute|undrop)\b/i;

export function assertReadOnly(sql: string): string {
  const s = sql.trim().replace(/;\s*$/, "");
  if (s.includes(";")) throw new Error("Only a single statement is allowed.");
  if (!READ_ONLY.test(s)) throw new Error("Only SELECT / WITH / SHOW / DESCRIBE statements are allowed.");
  // Keywords inside string literals are fine; strip literals before checking.
  if (FORBIDDEN.test(s.replace(/'([^']|'')*'/g, "''"))) throw new Error("Statement contains a write or session keyword.");
  return s;
}

export const sqlLiteral = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
