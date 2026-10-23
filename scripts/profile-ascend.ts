// HR version: reads ONLY aggregate statistics from the Ascend HR database (read-only session) and writes
// data/hr-profile.json. That profile is the only thing the synthetic generator uses.
//
// Privacy by construction:
// - Every number is computed inside Postgres with GROUP BY; no employee-level row is ever fetched.
// - Any bucket with fewer than 5 people/records is suppressed (reported as null) or merged.
// - No names, ids, emails, titles, team/department names, goal titles, question text or free text are read.
// - Counts are returned as shares (percentages); the total headcount is rounded to the nearest 10.
//
// Usage: ASCEND_ENV=../Brain/company-brain/.env node --experimental-strip-types scripts/profile-ascend.ts
import pg from "pg";
import { writeFileSync } from "node:fs";

const envFile = process.env.ASCEND_ENV ?? "../Brain/company-brain/.env";
try {
  process.loadEnvFile(envFile);
} catch {
  console.error(`Could not read ${envFile}`);
  process.exit(1);
}
if (!process.env.ASCEND_DATABASE_URL) {
  console.error("ASCEND_DATABASE_URL is not set in that file.");
  process.exit(1);
}

const K = 5; // minimum group size
const db = new pg.Client({ connectionString: process.env.ASCEND_DATABASE_URL });
await db.connect();
await db.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
const q = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows;

const orgs = await q(`SELECT id FROM organizations ORDER BY "createdAt"`);
const ORG = process.env.ASCEND_ORG_ID ?? (orgs.length === 1 ? orgs[0].id : "");
if (!ORG) {
  console.error(`Found ${orgs.length} organizations; set ASCEND_ORG_ID.`);
  process.exit(1);
}

// Turns [{bucket, n}] into {bucket: share%} with small buckets suppressed.
function shares(rows: { bucket: string | number | null; n: string | number }[]) {
  const total = rows.reduce((s, r) => s + Number(r.n), 0);
  if (total < K) return { suppressed: true };
  const out: Record<string, number | null> = {};
  let small = 0;
  for (const r of rows) {
    const n = Number(r.n);
    if (n < K) small += n;
    else out[String(r.bucket ?? "none")] = Math.round((1000 * n) / total) / 10;
  }
  if (small) out["other (<5 each, merged)"] = small >= K ? Math.round((1000 * small) / total) / 10 : null;
  return out;
}

const profile: Record<string, unknown> = {
  generated_at: new Date().toISOString().slice(0, 10),
  method: "Aggregates only, computed in Postgres; buckets under 5 suppressed; shares in percent. No identifiers or text.",
};

// ---------------- Organisation shape ----------------
const active = Number((await q(`SELECT COUNT(*) AS n FROM memberships WHERE "organizationId" = $1 AND status::text = 'ACTIVE'`, [ORG]))[0].n);
profile.org = {
  active_headcount_rounded: Math.round(active / 10) * 10,
  team_size: shares(await q(
    `SELECT CASE WHEN c < 5 THEN '1-4' WHEN c < 10 THEN '5-9' WHEN c < 20 THEN '10-19' ELSE '20+' END AS bucket, COUNT(*) AS n
     FROM (SELECT "teamId", COUNT(*) AS c FROM memberships WHERE "organizationId" = $1 AND status::text = 'ACTIVE' AND "teamId" IS NOT NULL GROUP BY "teamId") t
     GROUP BY 1`, [ORG])),
  span_of_control: shares(await q(
    `SELECT CASE WHEN c <= 3 THEN '1-3' WHEN c <= 6 THEN '4-6' WHEN c <= 10 THEN '7-10' ELSE '11+' END AS bucket, COUNT(*) AS n
     FROM (SELECT "managerId", COUNT(*) AS c FROM memberships WHERE "organizationId" = $1 AND status::text = 'ACTIVE' AND "managerId" IS NOT NULL GROUP BY "managerId") t
     GROUP BY 1`, [ORG])),
  tenure_years: shares(await q(
    `SELECT CASE WHEN y < 1 THEN '<1' WHEN y < 2 THEN '1-2' WHEN y < 4 THEN '2-4' WHEN y < 7 THEN '4-7' ELSE '7+' END AS bucket, COUNT(*) AS n
     FROM (SELECT EXTRACT(EPOCH FROM (now() - "startDate")) / 31557600 AS y FROM memberships
           WHERE "organizationId" = $1 AND status::text = 'ACTIVE' AND "startDate" IS NOT NULL) t
     GROUP BY 1`, [ORG])),
  app_role: shares(await q(
    `SELECT role::text AS bucket, COUNT(*) AS n FROM memberships WHERE "organizationId" = $1 AND status::text = 'ACTIVE' GROUP BY 1`, [ORG])),
};

// ---------------- Performance reviews (completed cycles only) ----------------
const completed = `SELECT id FROM review_cycles WHERE "organizationId" = $1 AND status::text = 'COMPLETED'`;
profile.reviews = {
  completed_cycles: Number((await q(`SELECT COUNT(*) AS n FROM (${completed}) c`, [ORG]))[0].n),
  completion_rate_pct_by_type: Object.fromEntries(
    (await q(
      `SELECT type::text AS t, COUNT(*) AS total, COUNT(*) FILTER (WHERE status::text = 'SUBMITTED') AS submitted
       FROM reviews WHERE "cycleId" IN (${completed}) GROUP BY 1 HAVING COUNT(*) >= ${K}`, [ORG]))
      .map((r) => [r.t, Math.round((1000 * Number(r.submitted)) / Number(r.total)) / 10]),
  ),
  manager_rating: shares(await q(
    `SELECT ROUND(COALESCE("calibratedRating", "overallRating"))::int AS bucket, COUNT(*) AS n
     FROM reviews WHERE "cycleId" IN (${completed}) AND type::text = 'MANAGER_REVIEW' AND status::text = 'SUBMITTED'
       AND COALESCE("calibratedRating", "overallRating") IS NOT NULL GROUP BY 1 ORDER BY 1`, [ORG])),
  self_rating: shares(await q(
    `SELECT ROUND("overallRating")::int AS bucket, COUNT(*) AS n
     FROM reviews WHERE "cycleId" IN (${completed}) AND type::text = 'SELF_ASSESSMENT' AND status::text = 'SUBMITTED'
       AND "overallRating" IS NOT NULL GROUP BY 1 ORDER BY 1`, [ORG])),
  self_minus_manager_gap: shares(await q(
    `SELECT ROUND(s."overallRating" - m."overallRating")::int AS bucket, COUNT(*) AS n
     FROM reviews s JOIN reviews m ON m."cycleId" = s."cycleId" AND m."subjectId" = s."subjectId"
     WHERE s."cycleId" IN (${completed}) AND s.type::text = 'SELF_ASSESSMENT' AND m.type::text = 'MANAGER_REVIEW'
       AND s."overallRating" IS NOT NULL AND m."overallRating" IS NOT NULL GROUP BY 1 ORDER BY 1`, [ORG])),
  // Competency categories are generic framework labels; question text is never read.
  avg_rating_by_competency_category: Object.fromEntries(
    (await q(
      `SELECT COALESCE(qn.category, 'uncategorised') AS cat, ROUND(AVG(rr."ratingValue")::numeric, 2) AS avg, COUNT(*) AS n
       FROM review_responses rr JOIN reviews r ON r.id = rr."reviewId" JOIN review_template_questions qn ON qn.id = rr."questionId"
       WHERE r."cycleId" IN (${completed}) AND rr."ratingValue" IS NOT NULL GROUP BY 1 HAVING COUNT(*) >= ${K}`, [ORG]))
      .map((r) => [r.cat, Number(r.avg)]),
  ),
};

// ---------------- Goals ----------------
profile.goals = {
  status: shares(await q(`SELECT status::text AS bucket, COUNT(*) AS n FROM goals WHERE "organizationId" = $1 GROUP BY 1`, [ORG])),
  timeframe: shares(await q(`SELECT timeframe::text AS bucket, COUNT(*) AS n FROM goals WHERE "organizationId" = $1 GROUP BY 1`, [ORG])),
  progress: shares(await q(
    `SELECT CASE WHEN progress IS NULL OR progress < 25 THEN '0-24' WHEN progress < 50 THEN '25-49' WHEN progress < 75 THEN '50-74' WHEN progress < 100 THEN '75-99' ELSE '100' END AS bucket, COUNT(*) AS n
     FROM goals WHERE "organizationId" = $1 GROUP BY 1`, [ORG])),
  goals_per_person: shares(await q(
    `SELECT CASE WHEN c = 1 THEN '1' WHEN c <= 3 THEN '2-3' WHEN c <= 6 THEN '4-6' ELSE '7+' END AS bucket, COUNT(*) AS n
     FROM (SELECT "ownerId", COUNT(*) AS c FROM goals WHERE "organizationId" = $1 GROUP BY 1) t GROUP BY 1`, [ORG])),
  avg_key_results_per_goal: Number((await q(
    `SELECT ROUND(AVG(c)::numeric, 2) AS a FROM (SELECT g.id, COUNT(k.id) AS c FROM goals g LEFT JOIN key_results k ON k."goalId" = g.id
     WHERE g."organizationId" = $1 GROUP BY g.id) t HAVING COUNT(*) >= ${K}`, [ORG]))[0]?.a ?? null),
};

// ---------------- Feedback (metadata only) ----------------
profile.feedback = {
  type: shares(await q(`SELECT type::text AS bucket, COUNT(*) AS n FROM feedbacks WHERE "organizationId" = $1 GROUP BY 1`, [ORG])),
  visibility: shares(await q(`SELECT visibility::text AS bucket, COUNT(*) AS n FROM feedbacks WHERE "organizationId" = $1 GROUP BY 1`, [ORG])),
  anonymous: shares(await q(`SELECT CASE WHEN "isAnonymous" THEN 'anonymous' ELSE 'named' END AS bucket, COUNT(*) AS n FROM feedbacks WHERE "organizationId" = $1 GROUP BY 1`, [ORG])),
  per_active_person_per_month: Number((await q(
    `SELECT ROUND((COUNT(*)::numeric / NULLIF($2, 0)) / GREATEST(1, EXTRACT(EPOCH FROM (MAX("createdAt") - MIN("createdAt"))) / 2629800)::numeric, 2) AS r
     FROM feedbacks WHERE "organizationId" = $1 HAVING COUNT(*) >= ${K}`, [ORG, active]))[0]?.r ?? null),
};

await db.end();
writeFileSync(new URL("../data/hr-profile.json", import.meta.url), JSON.stringify(profile, null, 2) + "\n");
console.log("Wrote data/hr-profile.json (aggregates only). Review it before using it.");
