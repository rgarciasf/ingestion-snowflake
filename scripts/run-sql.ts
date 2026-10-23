// Runs the snowflake/*.sql setup files in order (or the files given as arguments) as an admin role.
// Usage: npm run setup                     -> all files (Revenue, then HR)
//        npm run setup -- 06_commitments_claude.sql hr/14_hr_commitments_claude.sql
import snowflake from "snowflake-sdk";
import { readdirSync, readFileSync } from "node:fs";

snowflake.configure({ logLevel: "ERROR" });
const DIR = new URL("../snowflake/", import.meta.url);
// Revenue version files (snowflake/0x_*.sql) first, then the HR version (snowflake/hr/1x_*.sql).
const listSql = (sub: string) => readdirSync(new URL(sub, DIR)).filter((f) => /^\d\d_.*\.sql$/.test(f)).sort().map((f) => sub + f);
const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((f) => f.replace(/^snowflake\//, ""))
  : [...listSql(""), ...listSql("hr/")];

const conn = snowflake.createConnection({
  account: process.env.SNOWFLAKE_ACCOUNT!,
  username: process.env.SNOWFLAKE_USER!,
  password: process.env.SNOWFLAKE_PASSWORD!,
  role: process.env.SNOWFLAKE_ADMIN_ROLE || "ACCOUNTADMIN",
});
await conn.connectAsync();

const exec = (sqlText: string) =>
  new Promise<any[]>((resolve, reject) =>
    conn.execute({
      sqlText,
      parameters: { MULTI_STATEMENT_COUNT: 0 },
      // With multi-statement SQL, NextResult() re-invokes this callback for each following statement;
      // the last result set (the file's check query) is what we print.
      complete: (err, stmt: any, rows) => {
        if (err) return reject(err);
        if (stmt.hasNext()) stmt.NextResult();
        else resolve(rows ?? []);
      },
    }),
  );

for (const f of files) {
  const t0 = Date.now();
  process.stdout.write(`▶ ${f} … `);
  try {
    const rows = await exec(readFileSync(new URL(f, DIR), "utf8"));
    console.log(`ok (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    if (rows.length) console.table(rows.slice(0, 25));
  } catch (err) {
    console.log("FAILED");
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
conn.destroy(() => {});
