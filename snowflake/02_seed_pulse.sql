-- 02_seed_pulse.sql: synthetic product + revenue data for the fictional Acme ("Pulse" analytics SaaS).
-- Deterministic (hash-based), so every run produces the same world. Data window: 2026-04-01 .. 2026-10-22.
--
-- The data tells the same stories as the documents and meeting notes:
--   * Release 4.2 (2026-09-29): Android 15 crash rate jumps from ~0.4% to ~1.8%; fix (4.3) slipped to November
--   * INC-2291 (2026-09-19): EUR/GBP September invoices voided + reissued; billing ticket spike
--   * DI-4410 (since 2026-10-01): eu-central ingestion delays of 10-20 min at 13:00-17:59 UTC
--   * Reports v1 deprecation: ~340 workspaces still use it (removal 2027-01-13)
--   * Story accounts (see STORY_ACCOUNTS) with usage declines / growth that match their call notes
--
-- Event volume: 10M rows by default (~1 min on XSMALL). Change ROWCOUNT in the EVENTS insert to scale.

USE WAREHOUSE ACME_WH;
USE SCHEMA ACME.PULSE;

-- ---------------------------------------------------------------- story accounts
CREATE OR REPLACE TABLE STORY_ACCOUNTS (
  WORKSPACE_ID NUMBER, NAME STRING, COUNTRY STRING, REGION STRING, INDUSTRY STRING,
  MRR_USD NUMBER(12,2), CSM STRING, RENEWAL_DATE DATE,
  DECLINE_START DATE, DECLINE_PCT NUMBER,      -- drop this % of events from DECLINE_START on
  GROWTH_BEFORE DATE, GROWTH_PCT NUMBER        -- drop this % of events before GROWTH_BEFORE (looks like growth)
) COMMENT = 'Named Enterprise accounts that appear in meeting notes. Seed input only; the agent should use WORKSPACES.';

INSERT INTO STORY_ACCOUNTS VALUES
  ( 7, 'Brightline Health', 'US', 'us-east',    'Healthcare', 9400, 'Ava Brooks',   '2027-01-31', NULL,         0, NULL,          0),
  (12, 'Kestrel Bank',      'DE', 'eu-central', 'Fintech',    8750, 'Mei Chen',     '2026-11-30', '2026-10-01', 40, NULL,         0),
  (21, 'Nord Games',        'US', 'us-east',    'Gaming',     6200, 'Diego Santos', '2026-12-15', '2026-09-29', 22, NULL,         0),
  (33, 'Atlas Retail',      'US', 'us-east',    'E-commerce', 7800, 'Liam O''Neil', '2027-01-10', NULL,         0, NULL,          0),
  (45, 'Lumio Learning',    'US', 'us-east',    'Education',  6600, 'Ava Brooks',   '2027-03-01', NULL,         0, '2026-08-15', 55),
  (58, 'Cobalt Logistics',  'NL', 'eu-central', 'Logistics',  5900, 'Mei Chen',     '2026-11-15', '2026-09-01', 55, NULL,         0),
  (64, 'Fern Media',        'GB', 'us-east',    'Media',      3900, 'Liam O''Neil', '2027-02-15', NULL,         0, NULL,          0),
  (71, 'Harbor Fintech',    'US', 'us-east',    'Fintech',    4300, 'Diego Santos', '2026-12-01', NULL,         0, NULL,          0);

-- ---------------------------------------------------------------- workspaces
CREATE OR REPLACE TABLE WORKSPACES (
  WORKSPACE_ID NUMBER        COMMENT 'Primary key. Joins to EVENTS / INVOICES / SUPPORT_TICKETS.WORKSPACE_ID',
  NAME         STRING        COMMENT 'Customer company name',
  PLAN         STRING        COMMENT 'Current plan: Free, Growth or Enterprise',
  REGION       STRING        COMMENT 'Data residency region: us-east or eu-central',
  COUNTRY      STRING        COMMENT 'Billing country as entered in the CRM (free text; legacy US rows are not normalised: USA, United States, us)',
  INDUSTRY     STRING,
  CREATED_AT   DATE          COMMENT 'Workspace creation date',
  MRR_USD      NUMBER(12,2)  COMMENT 'Current monthly recurring revenue in USD (0 for Free). ARR = MRR x 12',
  CSM          STRING        COMMENT 'Customer Success Manager (Enterprise only, NULL otherwise)',
  RENEWAL_DATE DATE          COMMENT 'Next contract renewal date (paying, non-churned workspaces)',
  CHURNED_AT   DATE          COMMENT 'Date the workspace cancelled; NULL if still active'
) COMMENT = 'One row per customer workspace (CRM + billing snapshot as of 2026-10-22)';

INSERT INTO WORKSPACES
WITH g AS (
  SELECT ROW_NUMBER() OVER (ORDER BY SEQ4()) AS w FROM TABLE(GENERATOR(ROWCOUNT => 6000))
), b AS (
  SELECT w,
    ABS(HASH(w, 'h')) AS h,
    CASE WHEN w <= 480 THEN 'Enterprise' WHEN w <= 2400 THEN 'Growth' ELSE 'Free' END AS plan,
    ARRAY_CONSTRUCT('US','US','US','US','US','GB','DE','FR','NL','ES','PT','CA','BR','IN','AU','JP','SE')[ABS(HASH(w, 'country')) % 17]::STRING AS cc,
    DATEADD(day, ABS(HASH(w, 'created')) % 1900, '2021-01-01'::DATE) AS created,
    ABS(HASH(w, 'churn')) % 100 AS churn_roll
  FROM g
), c AS (
  SELECT b.*,
    IFF(churn_roll < IFF(plan = 'Enterprise', 3, 9), DATEADD(day, ABS(HASH(w, 'cd')) % 190, '2026-04-01'::DATE), NULL) AS churned
  FROM b
)
SELECT
  c.w,
  COALESCE(s.NAME,
    ARRAY_CONSTRUCT('Bright','Nord','Kestrel','Lumio','Fern','Atlas','Cobalt','Juniper','Vela','Orchid','Quarry','Tidal','Summit','Ember','Harbor','Pioneer')[c.h % 16]::STRING
    || ' ' || ARRAY_CONSTRUCT('Labs','Health','Games','Retail','Analytics','Systems','Bank','Media','Learning','Logistics')[FLOOR(c.h / 16) % 10]::STRING
    || ' ' || c.w),
  c.plan,
  COALESCE(s.REGION, IFF(c.cc IN ('GB','DE','FR','NL','ES','PT','SE') AND ABS(HASH(c.w, 'reg')) % 10 < 7, 'eu-central', 'us-east')),
  COALESCE(s.COUNTRY, IFF(c.cc = 'US' AND c.created < '2023-01-01',
    ARRAY_CONSTRUCT('USA','United States','us','US')[ABS(HASH(c.w, 'messy')) % 4]::STRING, c.cc)),
  COALESCE(s.INDUSTRY, ARRAY_CONSTRUCT('SaaS','E-commerce','Fintech','Healthcare','Gaming','Media','Education','Marketplace')[FLOOR(c.h / 7) % 8]::STRING),
  c.created,
  COALESCE(s.MRR_USD, CASE c.plan
    WHEN 'Enterprise' THEN 2000 + c.h % 8100
    WHEN 'Growth' THEN IFF(c.h % 3 = 0, 479, 399) + IFF(c.h % 5 = 0, (c.h % 40) * 12, 0)
    ELSE 0 END),
  COALESCE(s.CSM, IFF(c.plan = 'Enterprise', ARRAY_CONSTRUCT('Ava Brooks','Diego Santos','Mei Chen','Liam O''Neil')[c.h % 4]::STRING, NULL)),
  COALESCE(s.RENEWAL_DATE, IFF(c.plan <> 'Free' AND c.churned IS NULL, DATEADD(day, ABS(HASH(c.w, 'renew')) % 365, '2026-10-23'::DATE), NULL)),
  IFF(s.WORKSPACE_ID IS NULL, c.churned, NULL)
FROM c LEFT JOIN STORY_ACCOUNTS s ON s.WORKSPACE_ID = c.w;

-- ---------------------------------------------------------------- events
CREATE OR REPLACE TABLE EVENTS (
  EVENT_TIME      TIMESTAMP_NTZ COMMENT 'When the event happened (UTC)',
  WORKSPACE_ID    NUMBER,
  USER_ID         NUMBER        COMMENT 'End user inside the customer workspace',
  SESSION_ID      NUMBER,
  EVENT_NAME      STRING        COMMENT 'Product event: page_view, dashboard_view (legacy SDK: Dashboard Viewed), query_run, reports_v1_view, funnel_viewed, export_started, alert_triggered, experiment_viewed, login, signup, app_crash, ai_insights_query',
  PLATFORM        STRING        COMMENT 'web, ios or android',
  OS_VERSION      STRING        COMMENT 'Mobile OS version, e.g. Android 15 / iOS 18 (empty for web)',
  APP_VERSION     STRING        COMMENT 'Mobile app release: 4.0, 4.1, 4.2 (empty for web)',
  COUNTRY         STRING        COMMENT 'ISO country code of the workspace (normalised)',
  REGION          STRING        COMMENT 'Data residency region: us-east or eu-central',
  PLAN            STRING        COMMENT 'Workspace plan at event time',
  DURATION_MS     NUMBER        COMMENT 'Query run time / dashboard load time in ms (0 for other events)',
  IS_ERROR        NUMBER(1)     COMMENT '1 if the action failed',
  INGEST_DELAY_MS NUMBER        COMMENT 'Delay between EVENT_TIME and when the event became queryable. Normal < 2,000 ms; > 300,000 ms counts as delayed'
) COMMENT = 'Product usage events from customer SDKs, 2026-04-01 to 2026-10-22';

INSERT INTO EVENTS
WITH r AS (
  SELECT
    n,
    ABS(HASH(n, 'h')) AS h,
    (ABS(HASH(n, 't')) % 1000000) / 1000000.0 AS ut,
    LEAST(6000, 1 + FLOOR(6000 * POW((ABS(HASH(n, 'w')) % 1000000) / 1000000.0, 1.7)))::NUMBER AS wid,
    ABS(HASH(n, 'p')) % 100 AS p,
    ABS(HASH(n, 'e')) % 10000 AS r1,
    ABS(HASH(n, 'e2')) % 1000 AS r2,
    ABS(HASH(n, 'keep')) % 100 AS keep
  FROM (SELECT SEQ8() AS n FROM TABLE(GENERATOR(ROWCOUNT => 10000000)))
), t AS (
  SELECT r.*,
    DATEADD(second, FLOOR(17712000 * POW(ut, 0.85)), '2026-04-01 00:00:00'::TIMESTAMP_NTZ) AS ts,   -- 205 days, growing volume
    CASE WHEN wid = 21 THEN IFF(p < 45, 'web', IFF(p < 55, 'ios', 'android'))                     -- Nord Games is mobile-heavy
         WHEN p < 70 THEN 'web' WHEN p < 85 THEN 'ios' ELSE 'android' END AS plat,
    FLOOR(110 * GREATEST(0.15, 1 - ut * 0.95)) AS reports_share
  FROM r
), e AS (
  SELECT t.*,
    CASE plat WHEN 'android' THEN ARRAY_CONSTRUCT('Android 13','Android 14','Android 15','Android 15')[h % 4]::STRING
              WHEN 'ios' THEN ARRAY_CONSTRUCT('iOS 17','iOS 18','iOS 18')[h % 3]::STRING ELSE '' END AS os,
    IFF(plat = 'web', '', CASE WHEN ts < '2026-08-15' THEN '4.0' WHEN ts < '2026-09-29' THEN '4.1' ELSE '4.2' END) AS ver
  FROM t
), named AS (
  SELECT e.*,
    CASE
      WHEN plat = 'android' AND os = 'Android 15' AND ver = '4.2' AND r1 < 180 THEN 'app_crash'
      WHEN plat <> 'web' AND r1 < 40 THEN 'app_crash'
      WHEN r2 < 300 THEN 'page_view'
      WHEN r2 < 500 THEN IFF(wid % 13 = 0, 'Dashboard Viewed', 'dashboard_view')
      WHEN r2 < 640 THEN 'query_run'
      WHEN r2 < 640 + IFF(wid IN (7, 33), 160, reports_share) AND (wid % 17 = 0 OR wid IN (7, 33)) THEN 'reports_v1_view'
      WHEN r2 < 830 THEN 'funnel_viewed'
      WHEN r2 < 880 THEN 'export_started'
      WHEN r2 < 930 THEN 'alert_triggered'
      WHEN r2 < 965 THEN 'experiment_viewed'
      WHEN r2 < 985 THEN 'login'
      WHEN r2 < 990 THEN 'signup'
      WHEN wid <= 25 AND ts >= '2026-10-01' THEN 'ai_insights_query'
      ELSE 'login' END AS event_name
  FROM e
)
SELECT
  x.ts,
  x.wid,
  x.wid * 1000 + x.h % CASE WHEN x.wid <= 480 THEN 800 WHEN x.wid <= 2400 THEN 120 ELSE 15 END AS user_id,
  (x.wid * 1000 + x.h % 800) * 10000 + DAYOFYEAR(x.ts) * 24 + HOUR(x.ts) AS session_id,
  x.event_name, x.plat, x.os, x.ver,
  CASE WHEN w.COUNTRY IN ('USA','United States','us') THEN 'US' ELSE w.COUNTRY END,
  w.REGION, w.PLAN,
  CASE WHEN x.event_name = 'query_run' THEN 40 + (x.h % 140) * 10 + IFF(x.h % 20 = 0, 1500 + (x.h % 400) * 10, 0)
       WHEN x.event_name IN ('dashboard_view','Dashboard Viewed') THEN 250 + (x.h % 180) * 10 ELSE 0 END,
  IFF(x.event_name = 'query_run' AND x.h % 1000 < 12, 1, 0),
  IFF(w.REGION = 'eu-central' AND x.ts >= '2026-10-01' AND HOUR(x.ts) BETWEEN 13 AND 17,
      600000 + (x.h % 600) * 1000, 80 + (x.h % 150) * 10)
FROM named x
JOIN WORKSPACES w ON w.WORKSPACE_ID = x.wid
LEFT JOIN STORY_ACCOUNTS s ON s.WORKSPACE_ID = x.wid
WHERE (w.CHURNED_AT IS NULL OR x.ts::DATE < w.CHURNED_AT)
  AND NOT (s.DECLINE_START IS NOT NULL AND x.ts >= s.DECLINE_START AND x.keep < s.DECLINE_PCT)
  AND NOT (s.GROWTH_BEFORE IS NOT NULL AND x.ts <  s.GROWTH_BEFORE AND x.keep < s.GROWTH_PCT);

-- ---------------------------------------------------------------- invoices
CREATE OR REPLACE TABLE INVOICES (
  INVOICE_ID    STRING,
  WORKSPACE_ID  NUMBER,
  INVOICE_MONTH DATE          COMMENT 'First day of the billed month',
  ISSUED_AT     TIMESTAMP_NTZ,
  CURRENCY      STRING        COMMENT 'USD, EUR or GBP',
  AMOUNT        NUMBER(12,2)  COMMENT 'Invoice total in invoice currency',
  AMOUNT_USD    NUMBER(12,2)  COMMENT 'Invoice total converted to USD',
  STATUS        STRING        COMMENT 'paid, open, void (cancelled, not owed) or reissued (replacement for a voided invoice)',
  PLAN          STRING
) COMMENT = 'Monthly invoices for paying workspaces. Revenue = SUM(AMOUNT_USD) excluding STATUS = void';

INSERT INTO INVOICES
WITH months AS (
  SELECT DATEADD(month, ROW_NUMBER() OVER (ORDER BY SEQ4()) - 1, '2026-04-01'::DATE) AS m FROM TABLE(GENERATOR(ROWCOUNT => 7))
), base AS (
  SELECT w.WORKSPACE_ID, w.PLAN, m.m,
    CASE WHEN w.COUNTRY IN ('DE','FR','NL','ES','PT') THEN 'EUR' WHEN w.COUNTRY = 'GB' THEN 'GBP' ELSE 'USD' END AS cur,
    ABS(HASH(w.WORKSPACE_ID, m.m)) AS h,
    w.MRR_USD
  FROM WORKSPACES w CROSS JOIN months m
  WHERE w.PLAN <> 'Free' AND w.CREATED_AT <= m.m AND (w.CHURNED_AT IS NULL OR w.CHURNED_AT > m.m)
), priced AS (
  SELECT base.*,
    CASE cur WHEN 'EUR' THEN 0.92 WHEN 'GBP' THEN 0.79 ELSE 1.0 END AS fx,
    MRR_USD + IFF(PLAN = 'Growth' AND h % 10 < 3, (h % 20) * 12, 0) AS usd,
    (m = '2026-09-01' AND cur IN ('EUR','GBP')) AS hit_by_incident
  FROM base
), rows_ AS (
  SELECT p.*, f.value::STRING AS st
  FROM priced p,
  LATERAL FLATTEN(input => IFF(p.hit_by_incident, ARRAY_CONSTRUCT('void','reissued'),
                                ARRAY_CONSTRUCT(IFF(p.m = '2026-10-01', 'open', 'paid')))) f
)
SELECT
  'INV-' || (70000 + ROW_NUMBER() OVER (ORDER BY m, WORKSPACE_ID, st)),
  WORKSPACE_ID, m,
  DATEADD(day, IFF(st = 'reissued', 19, 0), DATEADD(hour, 2, m::TIMESTAMP_NTZ)),   -- reissued 2026-09-20
  cur,
  ROUND(usd * fx, 2) + IFF(st = 'void', (h % 420 + 1) / 100.0, 0),          -- voided invoices had a rounding error
  ROUND(usd + IFF(st = 'void', (h % 420 + 1) / 100.0 / fx, 0), 2),
  st, PLAN
FROM rows_;

-- ---------------------------------------------------------------- support tickets
CREATE OR REPLACE TABLE SUPPORT_TICKETS (
  TICKET_ID              STRING,
  CREATED_AT             TIMESTAMP_NTZ,
  WORKSPACE_ID           NUMBER,
  CATEGORY               STRING  COMMENT 'billing, login_sso, data_delay, mobile_crash, export, how_to, bug',
  PRIORITY               STRING  COMMENT 'low, normal, high, urgent',
  FIRST_RESPONSE_MINUTES NUMBER  COMMENT 'Enterprise SLA: first response within 60 minutes',
  CSAT                   NUMBER  COMMENT 'Customer satisfaction 1-5, NULL if no survey response',
  STATUS                 STRING  COMMENT 'open or solved'
) COMMENT = 'Customer support tickets from the Support Desk';

INSERT INTO SUPPORT_TICKETS
WITH pools AS (
  SELECT 'paying' AS pool, WORKSPACE_ID, PLAN, ROW_NUMBER() OVER (ORDER BY WORKSPACE_ID) AS rn
    FROM WORKSPACES WHERE PLAN <> 'Free' AND CHURNED_AT IS NULL
  UNION ALL
  SELECT 'eu_billing', WORKSPACE_ID, PLAN, ROW_NUMBER() OVER (ORDER BY WORKSPACE_ID)
    FROM WORKSPACES WHERE PLAN <> 'Free' AND CHURNED_AT IS NULL AND COUNTRY IN ('GB','DE','FR','NL','ES','PT')
  UNION ALL
  SELECT 'eu_region', WORKSPACE_ID, PLAN, ROW_NUMBER() OVER (ORDER BY WORKSPACE_ID)
    FROM WORKSPACES WHERE PLAN <> 'Free' AND CHURNED_AT IS NULL AND REGION = 'eu-central'
  UNION ALL
  SELECT 'ws_' || WORKSPACE_ID, WORKSPACE_ID, PLAN, 1
    FROM WORKSPACES WHERE WORKSPACE_ID IN (7, 12, 21, 58, 71)
), pool_sizes AS (
  SELECT pool, COUNT(*) AS cnt FROM pools GROUP BY pool
), specs AS (
  -- key, rows, start, days, fixed category (NULL = random mix), pool, fixed priority (NULL = random)
  SELECT * FROM VALUES
    ('base',    26000, '2026-04-01 00:00:00'::TIMESTAMP_NTZ, 205, NULL,           'paying',     NULL),
    ('inc2291',   950, '2026-09-19 03:00:00'::TIMESTAMP_NTZ,   5, 'billing',      'eu_billing', NULL),
    ('di4410',    700, '2026-10-01 00:00:00'::TIMESTAMP_NTZ,  22, 'data_delay',   'eu_region',  NULL),
    ('android',   800, '2026-09-29 00:00:00'::TIMESTAMP_NTZ,  24, 'mobile_crash', 'paying',     NULL),
    ('kestrel',    18, '2026-10-01 00:00:00'::TIMESTAMP_NTZ,  22, 'data_delay',   'ws_12',      'urgent'),
    ('nord',       26, '2026-09-29 00:00:00'::TIMESTAMP_NTZ,  24, 'mobile_crash', 'ws_21',      'high'),
    ('cobalt',      4, '2026-09-05 00:00:00'::TIMESTAMP_NTZ,  40, 'how_to',       'ws_58',      'normal'),
    ('harbor',      6, '2026-09-24 00:00:00'::TIMESTAMP_NTZ,  20, 'login_sso',    'ws_71',      'urgent'),
    ('bright',      5, '2026-09-30 00:00:00'::TIMESTAMP_NTZ,  20, 'login_sso',    'ws_7',       'high')
    AS s(k, n, start_ts, days, cat, pool, prio)
), g AS (
  SELECT SEQ8() AS i FROM TABLE(GENERATOR(ROWCOUNT => 26000))
), gen AS (
  SELECT s.k, s.pool, s.prio, g.i,
    ABS(HASH(g.i, s.k)) AS h,
    DATEADD(second, ABS(HASH(g.i, s.k, 'ts')) % (s.days * 86400), s.start_ts) AS ts,
    COALESCE(s.cat, ARRAY_CONSTRUCT('how_to','how_to','how_to','bug','bug','export','login_sso','billing','data_delay','mobile_crash')[ABS(HASH(g.i, s.k, 'c')) % 10]::STRING) AS cat,
    1 + ABS(HASH(g.i, s.k, 'w')) % ps.cnt AS pick
  FROM specs s JOIN pool_sizes ps ON ps.pool = s.pool JOIN g ON g.i < s.n
)
SELECT
  'SUP-' || (200000 + ROW_NUMBER() OVER (ORDER BY gen.ts, gen.k, gen.i)),
  gen.ts, p.WORKSPACE_ID, gen.cat,
  COALESCE(gen.prio, ARRAY_CONSTRUCT('low','normal','normal','normal','high','urgent')[gen.h % 6]::STRING),
  IFF(p.PLAN = 'Enterprise', 5 + gen.h % 55, 30 + gen.h % 600) + IFF(gen.k IN ('kestrel','nord'), 60 + gen.h % 120, 0),
  IFF(gen.h % 3 = 0, NULL, IFF(gen.cat IN ('billing','data_delay','mobile_crash','login_sso') AND gen.k <> 'base', 1 + gen.h % 3, 2 + gen.h % 4)),
  IFF(gen.ts > '2026-10-15' AND gen.h % 3 = 0, 'open', 'solved')
FROM gen JOIN pools p ON p.pool = gen.pool AND p.rn = gen.pick
WHERE gen.ts < '2026-10-23';

-- ---------------------------------------------------------------- quick checks
SELECT 'workspaces' AS t, COUNT(*) FROM WORKSPACES
UNION ALL SELECT 'events', COUNT(*) FROM EVENTS
UNION ALL SELECT 'invoices', COUNT(*) FROM INVOICES
UNION ALL SELECT 'support_tickets', COUNT(*) FROM SUPPORT_TICKETS;
