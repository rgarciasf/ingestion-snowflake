-- HR version · 12_hr_views.sql: team-health view (the signals), the people semantic view (definitions),
-- and the tables the HR agent writes to. Snapshot date 2026-10-22.

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ACME_WH;

-- ---------------------------------------------------------------- write-back tables
CREATE TABLE IF NOT EXISTS ACME.BRAIN.PEOPLE_COMMITMENTS (
  COMMITMENT_ID   STRING DEFAULT UUID_STRING(),
  DOC_ID          STRING,
  CHUNK_ID        STRING        COMMENT 'Where the promise was made (citation)',
  TEAM            STRING,
  PROMISED_TO     STRING        COMMENT 'A named employee, or "team"',
  MEETING_DATE    DATE,
  OWNER           STRING        COMMENT 'Who made the promise (manager / HRBP)',
  COMMITMENT      STRING,
  CATEGORY        STRING        COMMENT 'workload, recovery, career, pay, staffing, other',
  DUE_DATE        DATE,
  STATUS          STRING        COMMENT 'open, done, broken or unknown (from the People Team follow-up notes)',
  STATUS_EVIDENCE STRING,
  QUOTE           STRING,
  EXTRACTED_BY    STRING,
  EXTRACTED_AT    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
) COMMENT = 'HR version: promises made to employees and teams, extracted by Claude in Cortex';

CREATE TABLE IF NOT EXISTS ACME.BRAIN.PEOPLE_ACTIONS (
  ACTION_ID              STRING DEFAULT UUID_STRING(),
  CREATED_AT             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  CREATED_BY_ROLE        STRING DEFAULT CURRENT_ROLE(),
  TEAM                   STRING,
  RISK_LEVEL             STRING COMMENT 'high, medium, low',
  SUMMARY                STRING,
  EVIDENCE               VARIANT,
  ACTIONS                VARIANT COMMENT 'owner, action, due date, category',
  REQUIRES_APPROVAL_FROM STRING COMMENT 'e.g. Total Rewards for pay-affecting actions',
  STATUS                 STRING DEFAULT 'open',
  APPROVED_BY            STRING
) COMMENT = 'HR version: team retention plans written by the agent after HRBP approval';

-- ---------------------------------------------------------------- survey: team-level scores (k >= 5)
-- Raw answers are protected by an aggregation policy (aggregate-only, groups of 5+), so they cannot be joined
-- into other views. This table holds the only team-level survey numbers anyone sees; teams under 5 are left out.
CREATE OR REPLACE TABLE ACME.PEOPLE.SURVEY_TEAM_SCORES
  COMMENT = 'Pulse survey scores per team (only teams with 5+ responses in the October pulse)'
AS
SELECT TEAM,
  ROUND(100 * (COUNT_IF(PULSE = '2026-10' AND ENPS_SCORE >= 9) - COUNT_IF(PULSE = '2026-10' AND ENPS_SCORE <= 6)) / NULLIF(COUNT_IF(PULSE = '2026-10'), 0)) AS enps_oct,
  ROUND(100 * (COUNT_IF(PULSE = '2026-Q3' AND ENPS_SCORE >= 9) - COUNT_IF(PULSE = '2026-Q3' AND ENPS_SCORE <= 6)) / NULLIF(COUNT_IF(PULSE = '2026-Q3'), 0)) AS enps_q3,
  ROUND(AVG(IFF(PULSE = '2026-10', WORKLOAD_SCORE, NULL)), 2) AS workload_oct,
  ROUND(AVG(IFF(PULSE = '2026-10', INTENT_TO_STAY, NULL)), 2) AS stay_oct,
  COUNT_IF(PULSE = '2026-10') AS responses_oct
FROM ACME.PEOPLE.SURVEY_RESPONSES
GROUP BY TEAM
HAVING COUNT_IF(PULSE = '2026-10') >= 5 AND COUNT_IF(PULSE = '2026-Q3') >= 5;

-- ---------------------------------------------------------------- team health
CREATE OR REPLACE VIEW ACME.PEOPLE.TEAM_HEALTH COPY GRANTS
  COMMENT = 'HR version: per team workload, recovery, engagement, attrition and overdue promises, as of 2026-10-22. Survey results only for 5+ responses.'
AS
WITH params AS (SELECT '2026-10-22'::DATE AS as_of),
hc AS (
  SELECT e.TEAM, ANY_VALUE(e.DEPARTMENT) AS DEPARTMENT, ANY_VALUE(t.MANAGER) AS MANAGER, ANY_VALUE(e.REGION) AS REGION,
    COUNT_IF(e.STATUS = 'active') AS headcount,
    COUNT_IF(e.EXIT_TYPE = 'voluntary' AND e.EXIT_DATE >= DATEADD(day, -90, p.as_of)) AS vol_exits_90d,
    ROUND(100 * COUNT_IF(e.STATUS = 'active' AND e.SALARY_USD < (e.BAND_MIN_USD + e.BAND_MAX_USD) / 2)
          / NULLIF(COUNT_IF(e.STATUS = 'active' AND e.SALARY_USD IS NOT NULL), 0), 0) AS pct_below_band_mid
  FROM ACME.PEOPLE.EMPLOYEES e JOIN ACME.PEOPLE.TEAMS t ON t.TEAM = e.TEAM, params p
  GROUP BY e.TEAM
),
wl AS (
  SELECT w.TEAM,
    -- last 3 weeks (Oct 5, 12, 19) vs the 8 weeks before (Aug 10 .. Sep 28)
    SUM(IFF(w.WEEK_START >= '2026-10-05', w.AFTER_HOURS_HOURS, 0)) / NULLIF(COUNT(DISTINCT IFF(w.WEEK_START >= '2026-10-05', w.EMPLOYEE_ID, NULL)), 0) / 3 AS ah_recent,
    SUM(IFF(w.WEEK_START BETWEEN '2026-08-10' AND '2026-09-28', w.AFTER_HOURS_HOURS, 0)) / NULLIF(COUNT(DISTINCT IFF(w.WEEK_START BETWEEN '2026-08-10' AND '2026-09-28', w.EMPLOYEE_ID, NULL)), 0) / 8 AS ah_prior,
    SUM(IFF(w.WEEK_START >= '2026-10-05', w.PAGES, 0)) / NULLIF(COUNT(DISTINCT IFF(w.WEEK_START >= '2026-10-05', w.EMPLOYEE_ID, NULL)), 0) / 3 AS pages_recent,
    SUM(IFF(w.WEEK_START >= '2026-09-14', w.PTO_DAYS, 0)) / NULLIF(COUNT(DISTINCT IFF(w.WEEK_START >= '2026-09-14', w.EMPLOYEE_ID, NULL)), 0) AS pto_6w
  FROM ACME.PEOPLE.WORKLOAD_WEEKLY w
  GROUP BY w.TEAM
),
survey AS (
  SELECT * FROM ACME.PEOPLE.SURVEY_TEAM_SCORES
),
perf AS (
  SELECT TEAM,
    ROUND(AVG(PROGRESS)) AS goal_progress,
    ROUND(100 * COUNT_IF(STATUS = 'AT_RISK') / NULLIF(COUNT(*), 0)) AS goals_at_risk_pct
  FROM ACME.PEOPLE.GOALS GROUP BY TEAM HAVING COUNT(*) >= 5
),
gap AS (
  SELECT s.TEAM, ROUND(AVG(s.OVERALL_RATING - m.OVERALL_RATING), 2) AS self_minus_manager
  FROM ACME.PEOPLE.REVIEWS s JOIN ACME.PEOPLE.REVIEWS m ON m.SUBJECT_ID = s.SUBJECT_ID AND m.CYCLE = s.CYCLE
  WHERE s.CYCLE = '2026-H1' AND s.REVIEW_TYPE = 'SELF_ASSESSMENT' AND m.REVIEW_TYPE = 'MANAGER_REVIEW'
    AND s.OVERALL_RATING IS NOT NULL AND m.OVERALL_RATING IS NOT NULL
  GROUP BY s.TEAM HAVING COUNT(*) >= 5
),
recognition AS (
  SELECT f.TEAM,
    COUNT_IF(f.CREATED_AT >= '2026-09-22') AS fb_last_30d,
    COUNT_IF(f.CREATED_AT >= '2026-06-24' AND f.CREATED_AT < '2026-09-22') / 3.0 AS fb_prior_30d_avg
  FROM ACME.PEOPLE.FEEDBACK f GROUP BY f.TEAM
),
promises AS (
  SELECT c.TEAM,
    COUNT_IF(c.STATUS IN ('open', 'broken', 'unknown') AND c.DUE_DATE < p.as_of) AS overdue,
    COUNT_IF(c.STATUS = 'broken') AS broken
  FROM ACME.BRAIN.PEOPLE_COMMITMENTS c, params p
  GROUP BY c.TEAM
)
SELECT
  hc.TEAM, hc.DEPARTMENT, hc.MANAGER, hc.REGION,
  hc.headcount AS HEADCOUNT,
  hc.vol_exits_90d AS VOLUNTARY_EXITS_90D,
  ROUND(100 * hc.vol_exits_90d * 4 / NULLIF(hc.headcount + hc.vol_exits_90d, 0), 1) AS ANNUALIZED_VOL_ATTRITION_PCT,
  ROUND(wl.ah_recent, 1) AS AFTER_HOURS_PER_PERSON_WEEK_LAST_3W,
  ROUND(wl.ah_prior, 1) AS AFTER_HOURS_PER_PERSON_WEEK_PRIOR_8W,
  ROUND(100 * (wl.ah_recent - wl.ah_prior) / NULLIF(wl.ah_prior, 0)) AS AFTER_HOURS_CHANGE_PCT,
  ROUND(wl.pages_recent, 1) AS PAGES_PER_PERSON_WEEK_LAST_3W,
  ROUND(wl.pto_6w, 1) AS PTO_DAYS_PER_PERSON_LAST_6W,
  s.enps_oct AS ENPS_OCT, s.enps_q3 AS ENPS_Q3, s.workload_oct AS WORKLOAD_SCORE_OCT, s.stay_oct AS INTENT_TO_STAY_OCT,
  s.responses_oct AS SURVEY_RESPONSES_OCT,
  COALESCE(pr.overdue, 0) AS OVERDUE_PROMISES,
  COALESCE(pr.broken, 0) AS BROKEN_PROMISES,
  hc.pct_below_band_mid AS PCT_BELOW_BAND_MID,
  perf.goal_progress AS AVG_GOAL_PROGRESS_PCT,
  perf.goals_at_risk_pct AS GOALS_AT_RISK_PCT,
  gap.self_minus_manager AS SELF_MINUS_MANAGER_GAP_2026H1,
  rec.fb_last_30d AS PEER_FEEDBACK_LAST_30D,
  ROUND(rec.fb_prior_30d_avg, 1) AS PEER_FEEDBACK_PRIOR_30D_AVG
FROM hc
LEFT JOIN wl ON wl.TEAM = hc.TEAM
LEFT JOIN survey s ON s.TEAM = hc.TEAM
LEFT JOIN promises pr ON pr.TEAM = hc.TEAM
LEFT JOIN perf ON perf.TEAM = hc.TEAM
LEFT JOIN gap ON gap.TEAM = hc.TEAM
LEFT JOIN recognition rec ON rec.TEAM = hc.TEAM;

-- ---------------------------------------------------------------- semantic view (official people metrics)
CREATE OR REPLACE SEMANTIC VIEW ACME.PEOPLE.PEOPLE_ANALYTICS
  TABLES (
    employees AS ACME.PEOPLE.EMPLOYEES PRIMARY KEY (EMPLOYEE_ID) WITH SYNONYMS = ('people', 'staff') COMMENT = 'Current and former employees',
    workload AS ACME.PEOPLE.WORKLOAD_WEEKLY COMMENT = 'Weekly after-hours work, pages and PTO per employee'
  )
  RELATIONSHIPS (
    workload_employee AS workload (EMPLOYEE_ID) REFERENCES employees
  )
  FACTS (
    workload.after_hours AS AFTER_HOURS_HOURS,
    workload.pages AS PAGES,
    workload.pto_days AS PTO_DAYS
  )
  DIMENSIONS (
    employees.team AS TEAM,
    employees.department AS DEPARTMENT,
    employees.region AS REGION,
    employees.level AS LEVEL,
    employees.employee_status AS STATUS,
    employees.exit_type AS EXIT_TYPE,
    employees.exit_month AS DATE_TRUNC('month', EXIT_DATE),
    workload.week_start AS WEEK_START
  )
  METRICS (
    employees.headcount AS COUNT_IF(STATUS = 'active') COMMENT = 'Active employees',
    employees.voluntary_exits AS COUNT_IF(EXIT_TYPE = 'voluntary'),
    employees.avg_tenure_years AS AVG(DATEDIFF(day, HIRE_DATE, COALESCE(EXIT_DATE, '2026-10-22'::DATE)) / 365.25),
    workload.after_hours_per_person_week AS SUM(AFTER_HOURS_HOURS) / NULLIF(COUNT(DISTINCT EMPLOYEE_ID || '-' || WEEK_START), 0)
      COMMENT = 'Average after-hours hours per person per week',
    workload.pages_total AS SUM(PAGES),
    workload.pto_days_total AS SUM(PTO_DAYS)
  )
  COMMENT = 'HR version: people metrics. Survey data is not here on purpose: use TEAM_HEALTH (5+ responses only).';
