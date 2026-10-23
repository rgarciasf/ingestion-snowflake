-- 08_ai_subscriptions.sql: AI token plans, subscriptions and daily token usage (Sep 1 - Oct 22, 2026), plus the
-- AI_CONSUMPTION_HEALTH view: projected allowance burn, overage revenue, inference cost and gross margin per account.
-- Story accounts:
--   45 Lumio Learning     AI Starter, usage ramping since the course-team rollout -> ~3-4x allowance (overage + upgrade)
--   23 Bright Health 23   AI Beta (unlimited) design partner, output-heavy -> inference cost above the flat price
--   12 Kestrel Bank       AI Pro, almost no usage -> shelfware before a shaky renewal
--   19 Nord Bank 19       AI Pro, an integration loop since Oct 14 -> ~8x daily usage, bill shock before renewal
-- All synthetic.

USE ROLE ACCOUNTADMIN;
USE WAREHOUSE ACME_WH;
USE SCHEMA ACME.PULSE;

CREATE OR REPLACE TABLE AI_PLANS (
  AI_PLAN STRING, MONTHLY_TOKENS NUMBER COMMENT 'NULL = unlimited', PRICE_USD NUMBER COMMENT 'Monthly price (Enterprise AI Starter is included = 0)',
  OVERAGE_PER_M_USD NUMBER, NOTES STRING
) COMMENT = 'AI token plans (see the AI Token Plans & Overage Policy document)';
INSERT INTO AI_PLANS VALUES
  ('AI Starter', 5000000, 0, 80, 'Included with Enterprise; $49/month on Growth'),
  ('AI Pro', 25000000, 1500, 80, NULL),
  ('AI Scale', 100000000, 5000, 80, NULL),
  ('AI Beta (unlimited)', NULL, 1500, 0, 'Grandfathered design partners until 2026-12-31');

CREATE OR REPLACE TABLE AI_SUBSCRIPTIONS (
  WORKSPACE_ID NUMBER, AI_PLAN STRING, MONTHLY_TOKENS NUMBER, PRICE_USD NUMBER, STARTED_AT DATE
) COMMENT = 'Current AI plan per workspace';
INSERT INTO AI_SUBSCRIPTIONS
WITH s AS (
  SELECT WORKSPACE_ID, PLAN, ABS(HASH(WORKSPACE_ID, 'ai')) % 100 AS r
  FROM WORKSPACES WHERE CHURNED_AT IS NULL AND PLAN <> 'Free'
), chosen AS (
  SELECT WORKSPACE_ID, PLAN,
    CASE WORKSPACE_ID WHEN 45 THEN 'AI Starter' WHEN 23 THEN 'AI Beta (unlimited)' WHEN 12 THEN 'AI Pro' WHEN 19 THEN 'AI Pro' WHEN 21 THEN 'AI Starter'
      ELSE CASE WHEN PLAN = 'Enterprise' THEN CASE WHEN r < 5 THEN 'AI Scale' WHEN r < 25 THEN 'AI Pro' ELSE 'AI Starter' END ELSE 'AI Starter' END
    END AS AI_PLAN
  FROM s WHERE PLAN = 'Enterprise' OR r < 15
)
SELECT c.WORKSPACE_ID, c.AI_PLAN, p.MONTHLY_TOKENS,
  IFF(c.AI_PLAN = 'AI Starter' AND c.PLAN = 'Growth', 49, p.PRICE_USD),
  DATEADD(day, ABS(HASH(c.WORKSPACE_ID, 'aistart')) % 60, '2026-06-01'::DATE)
FROM chosen c JOIN AI_PLANS p ON p.AI_PLAN = c.AI_PLAN;

CREATE OR REPLACE TABLE AI_TOKEN_USAGE_DAILY (
  WORKSPACE_ID NUMBER, USAGE_DATE DATE,
  FEATURE STRING COMMENT 'nl_query (natural-language query), summaries, ai_insights (early access, workspaces 1-25 since Oct 1)',
  INPUT_TOKENS NUMBER, OUTPUT_TOKENS NUMBER, REQUESTS NUMBER
) COMMENT = 'Metered AI token usage per workspace, day and feature';
INSERT INTO AI_TOKEN_USAGE_DAILY
WITH days AS (
  SELECT DATEADD(day, ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1, '2026-09-01'::DATE) AS d FROM TABLE(GENERATOR(ROWCOUNT => 52))
), f AS (
  SELECT * FROM VALUES ('nl_query', 0.55), ('summaries', 0.25), ('ai_insights', 0.20) AS f(feature, share)
), base AS (
  SELECT a.WORKSPACE_ID, d.d, f.feature, f.share,
    COALESCE(a.MONTHLY_TOKENS, 25000000) / 30.0 AS daily_allow,
    0.25 + MOD(ABS(HASH(a.WORKSPACE_ID, 'util')), 60) / 100.0 AS util,                 -- typical accounts use 25-85%
    1 + 0.006 * DATEDIFF(day, '2026-09-01', d.d) AS growth,
    0.6 + MOD(ABS(HASH(a.WORKSPACE_ID, d.d, f.feature)), 80) / 100.0 AS noise,
    IFF(DAYOFWEEKISO(d.d) >= 6, 0.35, 1) AS weekday
  FROM AI_SUBSCRIPTIONS a CROSS JOIN days d CROSS JOIN f
  WHERE f.feature <> 'ai_insights' OR (a.WORKSPACE_ID <= 25 AND d.d >= '2026-10-01')
), t AS (
  SELECT b.*,
    daily_allow * share * noise * weekday * growth *
    CASE WORKSPACE_ID
      WHEN 45 THEN 1.4 + 0.045 * GREATEST(0, DATEDIFF(day, '2026-09-15', d))
      WHEN 23 THEN 16
      WHEN 12 THEN 0.03
      WHEN 19 THEN IFF(d >= '2026-10-14', 7.5, 0.55)
      ELSE util END AS tokens
  FROM base b
)
SELECT WORKSPACE_ID, d, feature,
  ROUND(tokens * IFF(WORKSPACE_ID = 23, 0.62, 0.8)),
  ROUND(tokens * IFF(WORKSPACE_ID = 23, 0.38, 0.2)),
  GREATEST(1, ROUND(tokens / IFF(WORKSPACE_ID = 23, 60000, 9000)))
FROM t;

-- ---------------------------------------------------------------- consumption health (as of 2026-10-22)
CREATE OR REPLACE VIEW AI_CONSUMPTION_HEALTH COPY GRANTS
  COMMENT = 'Per AI subscriber: October month-to-date and projected usage vs allowance, projected overage, inference cost and AI gross margin. Projection = MTD + last-7-day daily average x 9 remaining days.'
AS
WITH u AS (
  SELECT WORKSPACE_ID,
    SUM(IFF(USAGE_DATE >= '2026-10-01', INPUT_TOKENS + OUTPUT_TOKENS, 0)) AS mtd,
    SUM(IFF(USAGE_DATE >= '2026-10-16', INPUT_TOKENS + OUTPUT_TOKENS, 0)) / 7.0 AS last7_daily,
    SUM(IFF(USAGE_DATE < '2026-10-01', INPUT_TOKENS + OUTPUT_TOKENS, 0)) AS sep_total,
    SUM(IFF(USAGE_DATE >= '2026-10-01', INPUT_TOKENS, 0)) AS mtd_in,
    SUM(IFF(USAGE_DATE >= '2026-10-01', OUTPUT_TOKENS, 0)) AS mtd_out
  FROM AI_TOKEN_USAGE_DAILY GROUP BY WORKSPACE_ID
), p AS (
  SELECT a.*, w.NAME, w.PLAN, w.REGION, w.CSM, w.RENEWAL_DATE, w.MRR_USD, pl.OVERAGE_PER_M_USD,
    u.mtd, u.last7_daily, u.sep_total, u.mtd + u.last7_daily * 9 AS projected,
    (u.mtd_in * 4 + u.mtd_out * 20) / NULLIF(u.mtd, 0) AS cost_per_m_usd
  FROM AI_SUBSCRIPTIONS a
  JOIN WORKSPACES w ON w.WORKSPACE_ID = a.WORKSPACE_ID
  JOIN AI_PLANS pl ON pl.AI_PLAN = a.AI_PLAN
  LEFT JOIN u ON u.WORKSPACE_ID = a.WORKSPACE_ID
), m AS (
  SELECT p.*,
    GREATEST(0, projected - COALESCE(MONTHLY_TOKENS, projected)) / 1e6 * OVERAGE_PER_M_USD AS overage_usd,
    projected / 1e6 * cost_per_m_usd AS cost_usd
  FROM p
)
SELECT
  WORKSPACE_ID, NAME AS ACCOUNT, PLAN, REGION, CSM, RENEWAL_DATE, DATEDIFF(day, '2026-10-22', RENEWAL_DATE) AS DAYS_TO_RENEWAL,
  MRR_USD * 12 AS ARR_USD,
  AI_PLAN, MONTHLY_TOKENS / 1e6 AS ALLOWANCE_M, PRICE_USD AS AI_PRICE_USD,
  ROUND(sep_total / 1e6, 1) AS SEPT_TOKENS_M,
  ROUND(mtd / 1e6, 1) AS OCT_MTD_TOKENS_M,
  ROUND(last7_daily / 1e6, 2) AS LAST7_DAILY_TOKENS_M,
  ROUND(projected / 1e6, 1) AS OCT_PROJECTED_TOKENS_M,
  ROUND(100 * mtd / NULLIF(MONTHLY_TOKENS, 0)) AS MTD_PCT_OF_ALLOWANCE,
  ROUND(100 * projected / NULLIF(MONTHLY_TOKENS, 0)) AS PROJECTED_PCT_OF_ALLOWANCE,
  ROUND(overage_usd) AS PROJECTED_OVERAGE_USD,
  ROUND(cost_usd) AS PROJECTED_INFERENCE_COST_USD,
  ROUND(PRICE_USD + overage_usd) AS PROJECTED_AI_REVENUE_USD,
  ROUND(100 * (PRICE_USD + overage_usd - cost_usd) / NULLIF(PRICE_USD + overage_usd, 0)) AS AI_GROSS_MARGIN_PCT
FROM m;

-- ---------------------------------------------------------------- governance (same region rule as all customer data)
ALTER TABLE IF EXISTS ACME.PULSE.AI_SUBSCRIPTIONS     DROP ALL ROW ACCESS POLICIES;
ALTER TABLE IF EXISTS ACME.PULSE.AI_TOKEN_USAGE_DAILY DROP ALL ROW ACCESS POLICIES;
ALTER TABLE ACME.PULSE.AI_SUBSCRIPTIONS     ADD ROW ACCESS POLICY ACME.GOVERNANCE.ACCOUNT_REGION_POLICY ON (WORKSPACE_ID);
ALTER TABLE ACME.PULSE.AI_TOKEN_USAGE_DAILY ADD ROW ACCESS POLICY ACME.GOVERNANCE.ACCOUNT_REGION_POLICY ON (WORKSPACE_ID);
GRANT SELECT ON TABLE ACME.PULSE.AI_PLANS TO ROLE ACME_CS_LEAD;
GRANT SELECT ON TABLE ACME.PULSE.AI_PLANS TO ROLE ACME_CSM_EU;
GRANT SELECT ON TABLE ACME.PULSE.AI_SUBSCRIPTIONS TO ROLE ACME_CS_LEAD;
GRANT SELECT ON TABLE ACME.PULSE.AI_SUBSCRIPTIONS TO ROLE ACME_CSM_EU;
GRANT SELECT ON TABLE ACME.PULSE.AI_TOKEN_USAGE_DAILY TO ROLE ACME_CS_LEAD;
GRANT SELECT ON TABLE ACME.PULSE.AI_TOKEN_USAGE_DAILY TO ROLE ACME_CSM_EU;
GRANT SELECT ON VIEW ACME.PULSE.AI_CONSUMPTION_HEALTH TO ROLE ACME_CS_LEAD;
GRANT SELECT ON VIEW ACME.PULSE.AI_CONSUMPTION_HEALTH TO ROLE ACME_CSM_EU;

SELECT ACCOUNT, AI_PLAN, ALLOWANCE_M, OCT_MTD_TOKENS_M, OCT_PROJECTED_TOKENS_M, PROJECTED_PCT_OF_ALLOWANCE, PROJECTED_OVERAGE_USD, PROJECTED_INFERENCE_COST_USD, AI_GROSS_MARGIN_PCT
FROM AI_CONSUMPTION_HEALTH WHERE WORKSPACE_ID IN (12, 19, 23, 45, 21) ORDER BY WORKSPACE_ID;
