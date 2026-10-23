// HR version: builds snowflake/hr/10_hr_seed.sql, a synthetic Acme workforce (~230 people, all fictional)
// whose workload, survey and exit data match the HR notes in data/sources/people/. CEO: Jordan Lee.
// Usage: node scripts/build-hr-sql.mjs
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
mkdirSync(`${ROOT}snowflake/hr`, { recursive: true });

// Deterministic RNG so every run produces the same people.
let seed = 20261023;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const addDays = (iso, d) => new Date(Date.parse(iso) + d * 864e5).toISOString().slice(0, 10);

// Story knobs per team: OVERLOAD_FROM / FACTOR multiply after-hours work; SPIKE_TO ends a temporary spike.
const TEAMS = [
  // id, team, department, manager, region, location tier, size, on-call, overload from, factor, spike to
  [1, "Data Infra", "Engineering", "Sam Patel", "us", "tier1", 14, true, "2026-10-01", 3.2, null],
  [2, "Platform", "Engineering", "Marcus Webb", "us", "tier1", 16, true, "2026-10-01", 1.3, null],
  [3, "SRE", "Engineering", "Grace Liu", "us", "tier1", 9, true, "2026-10-01", 1.7, null],
  [4, "Product Eng", "Engineering", "Aisha Khan", "eu", "lisbon", 22, false, "2026-09-29", 2.6, null],
  [5, "Payments", "Engineering", "Victor Reyes", "us", "tier1", 10, true, "2026-09-19", 3.0, "2026-09-27"],
  [6, "Security", "Engineering", "Hannah Cho", "us", "tier2", 7, true, null, 1, null],
  [7, "Customer Success", "Customer Success", "Olivia Hart", "us", "tier1", 8, false, "2026-10-01", 1.6, null],
  [8, "Support", "Support", "Ben Torres", "us", "tier2", 22, false, "2026-09-19", 1.4, null],
  [9, "Sales", "Sales", "Carlos Mendez", "us", "tier1", 25, false, null, 1, null],
  [10, "Product Management", "Product", "Dana Ruiz", "us", "tier1", 8, false, null, 1, null],
  [11, "Design", "Product", "Elena Rossi", "eu", "lisbon", 6, false, null, 1, null],
  [12, "Finance", "G&A", "Rachel Gomez", "us", "tier2", 8, false, null, 1, null],
  [13, "People", "G&A", "Hana Sato", "us", "tier1", 6, false, null, 1, null],
  [14, "Marketing", "Marketing", "Lucy Grant", "us", "tier1", 12, false, null, 1, null],
];

// Managers' titles and levels where the Acme documents define them.
const MANAGER_TITLES = {
  "Grace Liu": ["SRE Manager", "M1"], "Hannah Cho": ["CISO", "M2"], "Olivia Hart": ["VP Customer Success", "M2"],
  "Dana Ruiz": ["VP Product", "M2"], "Rachel Gomez": ["Controller", "M1"], "Ben Torres": ["Support Lead", "M1"],
  "Aisha Khan": ["Product Eng Manager (owns the Android 4.3 fix)", "M1"],
};

// Named people from the Acme story (fictional). [name, team id, level, hire, last promo, salary position 0..1, title]
// Roles follow the original Acme documents: Jordan Lee is CEO, Lena Okafor is a Principal Engineer, etc.
const NAMED = [
  ["Daniel Brandt", 2, "VP", "2020-02-03", "2024-03-01", 0.6, "VP Engineering"],
  ["Lena Okafor", 1, "E6", "2020-05-10", "2023-03-01", 0.12, "Principal Engineer"],
  ["Omar Haddad", 1, "E4", "2022-01-17", "2024-03-01", 0.35, "Senior Data Engineer"],
  ["Chris Doyle", 1, "E4", "2022-09-05", "2025-03-01", 0.5, "Senior Data Engineer"],
  ["Yuki Tanaka", 3, "E4", "2021-11-08", "2024-03-01", 0.45, "Site Reliability Engineer"],
  ["Priya Nair", 2, "E5", "2021-02-01", "2025-03-01", 0.5, "Engineering Enablement Lead"],
  ["Hannah Cho", 6, "M2", "2020-09-14", "2024-03-01", 0.5, "CISO"],
  ["Ava Brooks", 7, "P3", "2021-03-15", "2024-03-01", 0.5, "Customer Success Manager"],
  ["Diego Santos", 7, "P3", "2022-06-01", "2025-03-01", 0.45, "Customer Success Manager"],
  ["Mei Chen", 7, "P3", "2021-08-23", "2023-03-01", 0.3, "Customer Success Manager (EU accounts)"],
  ["Liam O'Neil", 7, "P3", "2023-01-09", "2025-03-01", 0.4, "Customer Success Manager"],
  ["Tom Becker", 10, "P4", "2020-07-20", "2024-03-01", 0.55, "Product Manager (Reports v1 migration)"],
  ["Sofia Marin", 10, "P4", "2021-04-12", "2025-03-01", 0.5, "Product Manager (AI Insights)"],
  ["Rosa Delgado", 13, "P3", "2022-02-14", "2025-03-01", 0.5, "HR Business Partner"],
];

const FIRST = ["Alex", "Sam", "Jamie", "Taylor", "Morgan", "Riley", "Casey", "Avery", "Quinn", "Rowan", "Sofia", "Mateo", "Ines", "Tiago", "Leo", "Nina", "Kai", "Maya", "Ethan", "Zoe", "Lucas", "Amara", "Ravi", "Hugo", "Clara", "Ivan", "Noor", "Elif", "Jonas", "Mira", "Owen", "Lara", "Felix", "Aiko", "Diana", "Marco", "Sana", "Theo", "Yara", "Bruno"];
const LAST = ["Silva", "Moreau", "Kowalski", "Nakamura", "Okoye", "Lindqvist", "Ferreira", "Haddad", "Novak", "Brennan", "Costa", "Varga", "Ibrahim", "Larsen", "Mendes", "Petrov", "Rahman", "Schulz", "Tanaka", "Uchenna", "Vidal", "Walsh", "Yilmaz", "Zhou", "Almeida", "Banerjee", "Castro", "Duarte", "Eriksen", "Fontaine"];

// Base salary bands (Tier 1 US); tier2 = 90%, Lisbon = 60% (from the Compensation Bands policy).
const BANDS = {
  E3: [135000, 165000], E4: [170000, 210000], E5: [215000, 260000], E6: [265000, 320000],
  P1: [70000, 95000], P2: [95000, 125000], P3: [120000, 155000], P4: [150000, 190000],
  M1: [200000, 250000], M2: [240000, 290000], VP: [300000, 380000],
};
const TIER = { tier1: 1, tier2: 0.9, lisbon: 0.6 };

const usedNames = new Set(NAMED.map((n) => n[0]).concat(TEAMS.map((t) => t[3])));
const fakeName = () => {
  for (;;) {
    const n = `${pick(FIRST)} ${pick(LAST)}`;
    if (!usedNames.has(n)) return usedNames.add(n), n;
  }
};

const employees = [];
let nextId = 1001;
const mk = (o) => {
  const t = TEAMS.find((x) => x[0] === o.team);
  const [lo, hi] = BANDS[o.level].map((v) => Math.round(v * TIER[t[5]]));
  employees.push({
    id: nextId++, name: o.name, team: t[1], department: t[2], manager: o.manager ?? t[3], region: t[4], location: t[5],
    level: o.level, title: o.title, hire: o.hire, promo: o.promo,
    salary: Math.round((lo + (hi - lo) * o.pos) / 500) * 500, bandMin: lo, bandMax: hi,
    status: o.exit ? "terminated" : "active", exitDate: o.exit ?? null, exitType: o.exitType ?? null,
  });
};

for (const t of TEAMS) {
  const [id, team, dept, manager, , , size] = t;
  const eng = dept === "Engineering";
  const [mTitle, mLevel] = MANAGER_TITLES[manager] ?? [`${team} Manager`, "M1"];
  const named = NAMED.filter((n) => n[1] === id && n[0] !== manager);
  if (!NAMED.some((n) => n[0] === manager)) {
    mk({ team: id, name: manager, level: mLevel, title: mTitle, manager: dept === "Engineering" ? "Daniel Brandt" : "Jordan Lee", hire: addDays("2019-06-01", between(0, 900)), promo: addDays("2023-03-01", 365 * between(0, 2)), pos: 0.3 + rnd() * 0.5 });
  } else {
    const [, , level, hire, promo, pos, title] = NAMED.find((n) => n[0] === manager);
    mk({ team: id, name: manager, level, title, hire, promo, pos, manager: "Jordan Lee" });
  }
  for (const [name, , level, hire, promo, pos, title] of named) mk({ team: id, name, level, title, hire, promo, pos, manager: level === "VP" ? "Jordan Lee" : manager });
  for (let i = named.filter((n) => n[2] !== "VP").length; i < size - 1; i++) {
    const level = eng ? pick(["E3", "E3", "E4", "E4", "E4", "E5"]) : pick(["P1", "P2", "P2", "P3", "P3", "P4"]);
    const hire = addDays("2019-01-01", between(0, 2700));
    mk({ team: id, name: fakeName(), level, title: eng ? "Software Engineer" : `${team} Specialist`, hire, promo: rnd() < 0.6 ? addDays(hire, between(300, 900)) : null, pos: rnd() });
  }
}

// Exits: background churn plus the story exits (Data Infra x2, Mobile x1, Customer Success x1, all voluntary).
const storyExits = [
  ["Data Infra", "2026-09-18"], ["Data Infra", "2026-10-09"], ["Product Eng", "2026-10-01"], ["Customer Success", "2026-09-26"],
];
for (const [team, date] of storyExits) {
  mk({ team: TEAMS.find((t) => t[1] === team)[0], name: fakeName(), level: team === "Customer Success" ? "P3" : "E4", title: team === "Customer Success" ? "Customer Success Manager" : "Senior Software Engineer", hire: addDays("2021-01-01", between(0, 700)), promo: null, pos: 0.3, exit: date, exitType: "voluntary" });
}
for (let i = 0; i < 9; i++) {
  const t = pick(TEAMS.filter((x) => ![1, 4, 7].includes(x[0])));
  mk({ team: t[0], name: fakeName(), level: t[2] === "Engineering" ? "E3" : "P2", title: "Former employee", hire: addDays("2020-01-01", between(0, 1200)), promo: null, pos: rnd(), exit: addDays("2026-01-15", between(0, 250)), exitType: rnd() < 0.7 ? "voluntary" : "involuntary" });
}

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? String(v).toUpperCase() : `'${String(v).replace(/'/g, "''")}'`);

const sql = `-- GENERATED by scripts/build-hr-sql.mjs. HR version: synthetic Acme workforce. All people are fictional. Do not edit.
-- ${employees.length} employees across ${TEAMS.length} teams; weekly workload Apr-Oct 2026; three anonymous pulse surveys.
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ACME_WH;
CREATE SCHEMA IF NOT EXISTS ACME.PEOPLE COMMENT = 'HR version: workforce, workload and engagement data (synthetic)';
USE SCHEMA ACME.PEOPLE;

CREATE OR REPLACE TABLE TEAMS (
  TEAM_ID NUMBER, TEAM STRING, DEPARTMENT STRING, MANAGER STRING, REGION STRING COMMENT 'us or eu (Lisbon hub)',
  LOCATION_TIER STRING, ON_CALL BOOLEAN COMMENT 'Team carries a pager rotation',
  OVERLOAD_FROM DATE, OVERLOAD_FACTOR FLOAT, SPIKE_TO DATE
) COMMENT = 'Teams. OVERLOAD_* / SPIKE_TO are seed inputs that shape WORKLOAD_WEEKLY (not company data).';
INSERT INTO TEAMS VALUES
${TEAMS.map((t) => `(${t.filter((_, i) => i !== 6).map(q).join(", ")})`).join(",\n")};

CREATE OR REPLACE TABLE EMPLOYEES (
  EMPLOYEE_ID NUMBER, NAME STRING COMMENT 'Fictional name', TEAM STRING, DEPARTMENT STRING, MANAGER STRING,
  REGION STRING, LOCATION_TIER STRING COMMENT 'tier1, tier2 (US) or lisbon',
  LEVEL STRING COMMENT 'E3-E6 engineering, P1-P4 professional, M1-M2 manager, VP', TITLE STRING,
  HIRE_DATE DATE, LAST_PROMOTION_DATE DATE,
  SALARY_USD NUMBER COMMENT 'Base salary (USD equivalent). Masked for everyone except HR Business Partners',
  BAND_MIN_USD NUMBER, BAND_MAX_USD NUMBER,
  STATUS STRING COMMENT 'active or terminated', EXIT_DATE DATE, EXIT_TYPE STRING COMMENT 'voluntary or involuntary'
) COMMENT = 'One row per employee (current and former). Snapshot 2026-10-22.';
INSERT INTO EMPLOYEES VALUES
${employees.map((e) => `(${[e.id, e.name, e.team, e.department, e.manager, e.region, e.location, e.level, e.title, e.hire, e.promo, e.salary, e.bandMin, e.bandMax, e.status, e.exitDate, e.exitType].map(q).join(", ")})`).join(",\n")};

-- Weekly workload per employee (Mondays 2026-04-06 .. 2026-10-19), shaped by each team's story.
CREATE OR REPLACE TABLE WORKLOAD_WEEKLY (
  EMPLOYEE_ID NUMBER, TEAM STRING, WEEK_START DATE,
  AFTER_HOURS_HOURS FLOAT COMMENT 'Hours worked outside 8:00-19:00 local or on weekends',
  PAGES NUMBER COMMENT 'On-call pages received (on-call teams only)',
  PTO_DAYS FLOAT COMMENT 'Paid time off taken that week'
) COMMENT = 'Weekly workload signals per employee, from the calendar, pager and HR systems';
INSERT INTO WORKLOAD_WEEKLY
WITH weeks AS (
  SELECT DATEADD(week, ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1, '2026-04-06'::DATE) AS wk FROM TABLE(GENERATOR(ROWCOUNT => 29))
), base AS (
  SELECT e.EMPLOYEE_ID, e.TEAM, w.wk, t.ON_CALL,
    -- Is the team inside its overload window this week?
    (t.OVERLOAD_FROM IS NOT NULL AND w.wk >= DATEADD(day, -6, t.OVERLOAD_FROM) AND (t.SPIKE_TO IS NULL OR w.wk <= t.SPIKE_TO)) AS stressed,
    t.OVERLOAD_FACTOR AS factor
  FROM EMPLOYEES e
  JOIN TEAMS t ON t.TEAM = e.TEAM
  JOIN weeks w ON w.wk >= e.HIRE_DATE AND (e.EXIT_DATE IS NULL OR w.wk < e.EXIT_DATE)
), pto AS (
  -- ~1 PTO day every 3-4 weeks normally; almost none while a team is overloaded (the burnout signal).
  SELECT base.*,
    IFF(MOD(ABS(HASH(EMPLOYEE_ID, wk, 'pto')), 100) < IFF(stressed, 3, 28), 1 + MOD(ABS(HASH(EMPLOYEE_ID, wk, 'ptod')), 3), 0) AS pto_days
  FROM base
)
SELECT EMPLOYEE_ID, TEAM, wk,
  ROUND((1.5 + MOD(ABS(HASH(EMPLOYEE_ID, wk, 'ah')), 40) / 10.0) * IFF(stressed, factor, 1) * IFF(pto_days > 0, 0.4, 1), 1),
  IFF(ON_CALL, ROUND(MOD(ABS(HASH(EMPLOYEE_ID, wk, 'pg')), 4) * IFF(stressed, factor * 1.5, 1)), 0),
  pto_days
FROM pto;

-- Anonymous pulse survey: no employee id, only team. An aggregation policy enforces groups of 5+.
CREATE OR REPLACE TABLE SURVEY_RESPONSES (
  PULSE STRING COMMENT '2026-Q2 (June), 2026-Q3 (September), 2026-10 (October pulse)', PULSE_DATE DATE,
  TEAM STRING, DEPARTMENT STRING,
  ENPS_SCORE NUMBER COMMENT '0-10: how likely to recommend Acme as a workplace. eNPS = %9-10 minus %0-6',
  WORKLOAD_SCORE NUMBER COMMENT '1-5, 5 = workload is sustainable',
  MANAGER_SUPPORT NUMBER COMMENT '1-5', GROWTH_SCORE NUMBER COMMENT '1-5, career growth', INTENT_TO_STAY NUMBER COMMENT '1-5, plan to be here in 12 months'
) COMMENT = 'Anonymous engagement pulse responses (about 85% response rate). Team-level only; never individual.';
INSERT INTO SURVEY_RESPONSES
WITH pulses AS (
  SELECT * FROM VALUES ('2026-Q2', '2026-06-15'::DATE), ('2026-Q3', '2026-09-14'::DATE), ('2026-10', '2026-10-19'::DATE) AS p(pulse, d)
), r AS (
  SELECT p.pulse, p.d, e.TEAM, e.DEPARTMENT, e.EMPLOYEE_ID,
    -- Stress: how hard the team's story hits on the pulse date (0 = none).
    IFF(t.OVERLOAD_FROM IS NOT NULL AND p.d >= t.OVERLOAD_FROM AND (t.SPIKE_TO IS NULL OR p.d <= DATEADD(day, 14, t.SPIKE_TO)), t.OVERLOAD_FACTOR - 1, 0) AS stress,
    MOD(ABS(HASH(e.EMPLOYEE_ID, p.pulse, 's')), 100) / 100.0 AS u
  FROM EMPLOYEES e JOIN TEAMS t ON t.TEAM = e.TEAM CROSS JOIN pulses p
  WHERE e.HIRE_DATE <= p.d AND (e.EXIT_DATE IS NULL OR e.EXIT_DATE > p.d)
    AND MOD(ABS(HASH(e.EMPLOYEE_ID, p.pulse, 'resp')), 100) < 85
)
SELECT pulse, d, TEAM, DEPARTMENT,
  LEAST(10, GREATEST(0, ROUND(9.6 - stress * 1.0 - u * 4 + IFF(u > 0.85, 1.5, 0)))),
  LEAST(5, GREATEST(1, ROUND(4.1 - stress * 1.1 - u * 1.2))),
  LEAST(5, GREATEST(1, ROUND(4.2 - stress * 0.4 - u * 1.0))),
  LEAST(5, GREATEST(1, ROUND(3.9 - stress * 0.5 - u * 1.3 - IFF(TEAM = 'Data Infra' AND pulse = '2026-10', 0.6, 0)))),
  LEAST(5, GREATEST(1, ROUND(4.3 - stress * 0.9 - u * 1.2)))
FROM r;

SELECT 'teams' AS t, COUNT(*) AS n FROM TEAMS
UNION ALL SELECT 'employees', COUNT(*) FROM EMPLOYEES
UNION ALL SELECT 'workload_weeks', COUNT(*) FROM WORKLOAD_WEEKLY
UNION ALL SELECT 'survey_responses', COUNT(*) FROM SURVEY_RESPONSES;
`;
writeFileSync(`${ROOT}snowflake/hr/10_hr_seed.sql`, sql);
console.log(`Wrote snowflake/hr/10_hr_seed.sql: ${employees.length} employees, ${TEAMS.length} teams`);

// ======================================================================================================
// Performance data (snowflake/hr/11_hr_performance.sql): reviews, competency ratings, goals and feedback for
// the fictional employees above. Distributions come from data/hr-profile.json, aggregate statistics of a real
// HR system (no records, no identifiers); the HR story is layered on top.
// ======================================================================================================
const profile = JSON.parse(readFileSync(`${ROOT}data/hr-profile.json`, "utf8"));
const sample = (dist) => {
  const entries = Object.entries(dist).filter(([k, v]) => typeof v === "number" && !k.startsWith("other"));
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let r = rnd() * total;
  for (const [k, v] of entries) if ((r -= v) <= 0) return k;
  return entries.at(-1)[0];
};
const clamp = (v) => Math.max(1, Math.min(5, v));
const STRESSED = new Set(["Data Infra", "Product Eng", "Customer Success"]);
const STAR = { "Omar Haddad": 5, "Lena Okafor": 5 };

const cycles = [
  ["2025-H1", "2025-01-01", "2025-07-15"],
  ["2025-H2", "2025-07-01", "2026-01-31"],
  ["2026-H1", "2026-01-01", "2026-07-31"],
];
const submitRate = profile.reviews.completion_rate_pct_by_type;
const catAvg = profile.reviews.avg_rating_by_competency_category;
const catMean = Object.values(catAvg).reduce((a, b) => a + b, 0) / Object.values(catAvg).length;

const reviews = [];
const ratings = [];
let reviewId = 50001;
for (const [cycle, start, end] of cycles) {
  for (const e of employees) {
    if (e.hire > start || (e.exitDate && e.exitDate < end) || e.level === "VP") continue;
    const mgr = STAR[e.name] ?? Number(sample(profile.reviews.manager_rating));
    // Self = manager + a gap drawn from the profile, redrawn when it falls outside the profile's self-rating range.
    const selfMin = Math.min(...Object.keys(profile.reviews.self_rating).filter((k) => /^\d$/.test(k)).map(Number));
    let self = clamp(mgr + Number(sample(profile.reviews.self_minus_manager_gap)));
    for (let i = 0; i < 6 && self < selfMin; i++) self = clamp(mgr + Number(sample(profile.reviews.self_minus_manager_gap)));
    self = Math.max(selfMin, self);
    const mgrSubmitted = rnd() * 100 < submitRate.MANAGER_REVIEW;
    const selfSubmitted = rnd() * 100 < submitRate.SELF_ASSESSMENT;
    reviews.push([reviewId++, e.id, e.team, cycle, end, "SELF_ASSESSMENT", String(e.id), selfSubmitted ? "SUBMITTED" : "NOT_SUBMITTED", selfSubmitted ? self : null]);
    const mid = reviewId++;
    reviews.push([mid, e.id, e.team, cycle, end, "MANAGER_REVIEW", e.manager, mgrSubmitted ? "SUBMITTED" : "NOT_SUBMITTED", mgrSubmitted ? mgr : null]);
    if (mgrSubmitted) {
      for (const [cat, avg] of Object.entries(catAvg)) {
        if (cat === "People management" && !/^M|VP/.test(e.level)) continue;
        ratings.push([mid, e.id, e.team, cycle, cat, clamp(Math.round(mgr + (avg - catMean) + (rnd() - 0.5) * 1.2))]);
      }
    }
  }
}

// 2026 annual goals, as of 2026-10-22 (~80% of the year). Teams hit by incidents stall from late September.
const goals = [];
let goalId = 70001;
for (const e of employees.filter((x) => x.status === "active" && x.level !== "VP")) {
  const n = sample(profile.goals.goals_per_person) === "1" ? 1 : 2;
  for (let i = 0; i < n; i++) {
    let progress = Math.round(Math.min(100, 62 + rnd() * 38));
    if (STRESSED.has(e.team)) progress = Math.max(20, progress - 18 - Math.round(rnd() * 15));
    const status = progress >= 100 ? "COMPLETED" : progress < 55 ? "AT_RISK" : "ON_TRACK";
    goals.push([goalId++, e.id, e.team, "ANNUAL", "2026", progress, status, Math.max(2, Math.round(profile.goals.avg_key_results_per_goal + (rnd() - 0.5) * 3))]);
  }
}

// Feedback metadata (who recognised whom, when). Rate from the profile; recognition dries up in overloaded teams.
const feedbackRows = [];
let fbId = 90001;
const perPersonMonth = profile.feedback.per_active_person_per_month;
const actives = employees.filter((x) => x.status === "active");
for (let month = 0; month < 7; month++) {
  const monthStart = addDays("2026-04-01", month * 30);
  for (const e of actives) {
    const t = TEAMS.find((x) => x[1] === e.team);
    const overloaded = t[8] && monthStart >= t[8].slice(0, 8) + "01";
    if (rnd() >= perPersonMonth * (overloaded ? 0.3 : 1)) continue;
    const peers = actives.filter((x) => x.team === e.team && x.id !== e.id);
    if (!peers.length) continue;
    feedbackRows.push([fbId++, pick(peers).id, e.id, e.team, sample(profile.feedback.type), "PRIVATE", addDays(monthStart, between(0, 27))]);
  }
}

const perfSql = `-- GENERATED by scripts/build-hr-sql.mjs. HR version: synthetic performance data for the fictional Acme workforce.
-- Shape from data/hr-profile.json (aggregate statistics only, no records or identifiers from the source system).
-- ${reviews.length} reviews, ${ratings.length} competency ratings, ${goals.length} goals, ${feedbackRows.length} feedback events.
USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ACME_WH;
USE SCHEMA ACME.PEOPLE;

CREATE OR REPLACE TABLE REVIEWS (
  REVIEW_ID NUMBER, SUBJECT_ID NUMBER COMMENT 'EMPLOYEES.EMPLOYEE_ID being reviewed', TEAM STRING,
  CYCLE STRING COMMENT '2025-H1, 2025-H2, 2026-H1 (all completed)', CYCLE_END DATE,
  REVIEW_TYPE STRING COMMENT 'SELF_ASSESSMENT or MANAGER_REVIEW', AUTHOR STRING COMMENT 'Employee id (self) or manager name',
  STATUS STRING COMMENT 'SUBMITTED or NOT_SUBMITTED', OVERALL_RATING NUMBER COMMENT '1-5; NULL if not submitted'
) COMMENT = 'Performance reviews. Self vs manager gap = self rating minus manager rating for the same subject and cycle.';
INSERT INTO REVIEWS VALUES
${reviews.map((r) => `(${r.map(q).join(", ")})`).join(",\n")};

CREATE OR REPLACE TABLE REVIEW_RATINGS (
  REVIEW_ID NUMBER, SUBJECT_ID NUMBER, TEAM STRING, CYCLE STRING,
  COMPETENCY STRING COMMENT 'Communication, Results orientation, Problem solving, Customer focus, Collaboration, Agility, People management',
  RATING NUMBER COMMENT '1-5'
) COMMENT = 'Per-competency ratings from submitted manager reviews';
INSERT INTO REVIEW_RATINGS VALUES
${ratings.map((r) => `(${r.map(q).join(", ")})`).join(",\n")};

CREATE OR REPLACE TABLE GOALS (
  GOAL_ID NUMBER, OWNER_ID NUMBER, TEAM STRING, TIMEFRAME STRING, YEAR STRING,
  PROGRESS NUMBER COMMENT '0-100 as of 2026-10-22 (about 80% of the year elapsed)',
  STATUS STRING COMMENT 'ON_TRACK, AT_RISK (<55%), COMPLETED', KEY_RESULTS NUMBER
) COMMENT = '2026 annual goals';
INSERT INTO GOALS VALUES
${goals.map((r) => `(${r.map(q).join(", ")})`).join(",\n")};

CREATE OR REPLACE TABLE FEEDBACK (
  FEEDBACK_ID NUMBER, SENDER_ID NUMBER, RECEIVER_ID NUMBER, TEAM STRING COMMENT 'Receiver team',
  FEEDBACK_TYPE STRING, VISIBILITY STRING, CREATED_AT DATE
) COMMENT = 'Peer feedback metadata only (no content)';
INSERT INTO FEEDBACK VALUES
${feedbackRows.map((r) => `(${r.map(q).join(", ")})`).join(",\n")};

SELECT 'reviews' AS t, COUNT(*) AS n FROM REVIEWS
UNION ALL SELECT 'review_ratings', COUNT(*) FROM REVIEW_RATINGS
UNION ALL SELECT 'goals', COUNT(*) FROM GOALS
UNION ALL SELECT 'feedback', COUNT(*) FROM FEEDBACK;
`;
writeFileSync(`${ROOT}snowflake/hr/11_hr_performance.sql`, perfSql);
console.log(`Wrote snowflake/hr/11_hr_performance.sql: ${reviews.length} reviews, ${goals.length} goals, ${feedbackRows.length} feedback events`);
