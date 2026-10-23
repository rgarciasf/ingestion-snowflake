-- 04_search_semantic.sql: Cortex Search (documents + meetings), the semantic view (metric definitions),
-- the account-health view, and the tables the agent writes back to.

USE WAREHOUSE ACME_WH;
USE DATABASE ACME;

-- ---------------------------------------------------------------- Cortex Search over knowledge chunks
CREATE OR REPLACE CORTEX SEARCH SERVICE ACME.KNOWLEDGE.KNOWLEDGE_SEARCH
  ON CHUNK_TEXT
  ATTRIBUTES SOURCE_TYPE, ACCOUNT, TEAM, ACCESS, STATUS, DOC_ID, TITLE
  WAREHOUSE = ACME_WH
  TARGET_LAG = '1 hour'
  COMMENT = 'Hybrid search over Acme documents, policies, tickets, meeting transcripts and HR notes'
AS
  SELECT CHUNK_TEXT, CHUNK_ID, DOC_ID, TITLE, SOURCE_TYPE, ACCOUNT, TEAM, ACCESS, STATUS, UPDATED_ON, TRANSCRIPT_TS
  FROM ACME.KNOWLEDGE.DOC_CHUNKS;

-- ---------------------------------------------------------------- semantic view (the metrics glossary, enforced)
CREATE OR REPLACE SEMANTIC VIEW ACME.PULSE.PULSE_ANALYTICS
  TABLES (
    workspaces AS ACME.PULSE.WORKSPACES PRIMARY KEY (WORKSPACE_ID)
      WITH SYNONYMS = ('customers', 'accounts') COMMENT = 'One row per customer workspace',
    events AS ACME.PULSE.EVENTS
      COMMENT = 'Product usage events',
    invoices AS ACME.PULSE.INVOICES PRIMARY KEY (INVOICE_ID)
      COMMENT = 'Monthly invoices; void rows are cancelled and replaced by reissued rows',
    tickets AS ACME.PULSE.SUPPORT_TICKETS PRIMARY KEY (TICKET_ID)
      WITH SYNONYMS = ('support tickets', 'cases') COMMENT = 'Support desk tickets'
  )
  RELATIONSHIPS (
    events_workspace   AS events (WORKSPACE_ID)   REFERENCES workspaces,
    invoices_workspace AS invoices (WORKSPACE_ID) REFERENCES workspaces,
    tickets_workspace  AS tickets (WORKSPACE_ID)  REFERENCES workspaces
  )
  FACTS (
    workspaces.mrr_usd           AS MRR_USD,
    events.duration_ms           AS DURATION_MS,
    events.ingest_delay_ms       AS INGEST_DELAY_MS,
    invoices.amount_usd          AS AMOUNT_USD,
    tickets.first_response_min   AS FIRST_RESPONSE_MINUTES,
    tickets.csat_score           AS CSAT
  )
  DIMENSIONS (
    workspaces.workspace_id      AS WORKSPACE_ID,
    workspaces.account_name      AS NAME WITH SYNONYMS = ('customer', 'company') COMMENT = 'Customer company name',
    workspaces.plan              AS PLAN COMMENT = 'Free, Growth or Enterprise. Paying = Growth or Enterprise',
    workspaces.region            AS REGION,
    workspaces.industry          AS INDUSTRY,
    workspaces.csm               AS CSM COMMENT = 'Customer Success Manager',
    workspaces.renewal_date      AS RENEWAL_DATE,
    workspaces.churned_at        AS CHURNED_AT,
    workspaces.is_active         AS CHURNED_AT IS NULL COMMENT = 'TRUE if the customer has not churned',
    events.event_date            AS DATE(EVENT_TIME),
    events.event_week            AS DATE_TRUNC('week', EVENT_TIME),
    events.event_name            AS EVENT_NAME,
    events.platform              AS PLATFORM,
    events.os_version            AS OS_VERSION,
    events.app_version           AS APP_VERSION,
    invoices.invoice_month       AS INVOICE_MONTH,
    invoices.invoice_status      AS STATUS,
    invoices.currency            AS CURRENCY,
    tickets.ticket_date          AS DATE(CREATED_AT),
    tickets.category             AS CATEGORY,
    tickets.priority             AS PRIORITY,
    tickets.ticket_status        AS STATUS
  )
  METRICS (
    workspaces.customer_count    AS COUNT(IFF(CHURNED_AT IS NULL, WORKSPACE_ID, NULL)) COMMENT = 'Active (non-churned) customers',
    workspaces.total_mrr_usd     AS SUM(IFF(CHURNED_AT IS NULL, MRR_USD, 0)) COMMENT = 'Current MRR of active customers',
    workspaces.total_arr_usd     AS SUM(IFF(CHURNED_AT IS NULL, MRR_USD, 0)) * 12 COMMENT = 'ARR = active MRR x 12',
    events.event_count           AS COUNT(EVENT_NAME),
    events.active_users          AS COUNT(DISTINCT USER_ID),
    events.active_workspaces     AS COUNT(DISTINCT WORKSPACE_ID),
    events.mobile_crash_rate_pct AS 100 * COUNT_IF(EVENT_NAME = 'app_crash') / NULLIF(COUNT_IF(PLATFORM IN ('ios', 'android')), 0)
      COMMENT = 'app_crash events / all mobile events, in percent. Target below 1%',
    events.p95_query_ms          AS APPROX_PERCENTILE(IFF(EVENT_NAME = 'query_run', DURATION_MS, NULL), 0.95)
      COMMENT = 'p95 query latency; promise is under 2,000 ms',
    events.delayed_event_pct     AS 100 * COUNT_IF(INGEST_DELAY_MS > 300000) / NULLIF(COUNT(EVENT_NAME), 0)
      COMMENT = 'Share of events delayed more than 5 minutes',
    invoices.revenue_usd         AS SUM(IFF(STATUS <> 'void', AMOUNT_USD, 0)) COMMENT = 'Revenue, excluding voided invoices',
    tickets.ticket_count         AS COUNT(TICKET_ID),
    tickets.urgent_ticket_count  AS COUNT_IF(PRIORITY IN ('urgent', 'high')),
    tickets.avg_csat             AS AVG(CSAT) COMMENT = 'Average CSAT (1-5), surveys answered only'
  )
  COMMENT = 'Acme Pulse product, revenue and support metrics. Use these definitions for every number.';

-- ---------------------------------------------------------------- write-back tables (the agent's actions)
CREATE TABLE IF NOT EXISTS ACME.BRAIN.COMMITMENTS (
  COMMITMENT_ID   STRING DEFAULT UUID_STRING(),
  DOC_ID          STRING,
  CHUNK_ID        STRING        COMMENT 'Chunk where the commitment was made (citation)',
  WORKSPACE_ID    NUMBER,
  ACCOUNT         STRING,
  MEETING_DATE    DATE,
  OWNER           STRING        COMMENT 'Acme person who made the commitment',
  COMMITMENT      STRING,
  DUE_DATE        DATE,
  STATUS          STRING        COMMENT 'open, done or unknown (from later follow-up notes)',
  STATUS_EVIDENCE STRING,
  QUOTE           STRING,
  EXTRACTED_BY    STRING,
  EXTRACTED_AT    TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
) COMMENT = 'Promises made to customers in meetings, extracted by Claude';

CREATE TABLE IF NOT EXISTS ACME.BRAIN.RISK_ALERTS (
  ALERT_ID        STRING DEFAULT UUID_STRING(),
  CREATED_AT      TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  CREATED_BY_ROLE STRING DEFAULT CURRENT_ROLE(),
  WORKSPACE_ID    NUMBER,
  ACCOUNT         STRING,
  ARR_USD         NUMBER(12,2),
  RENEWAL_DATE    DATE,
  RISK_LEVEL      STRING        COMMENT 'high, medium, low',
  SUMMARY         STRING,
  EVIDENCE        VARIANT       COMMENT 'Verified numbers with the SQL that produced them, and cited chunks',
  ACTIONS         VARIANT       COMMENT 'Recommended actions: owner, action, due date',
  STATUS          STRING DEFAULT 'open',
  APPROVED_BY     STRING
) COMMENT = 'Revenue-at-risk alerts written by the agent after human approval';

CREATE TABLE IF NOT EXISTS ACME.BRAIN.AGENT_TRACES (
  TRACE_ID   STRING,
  CREATED_AT TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP(),
  ROLE_NAME  STRING,
  QUESTION   STRING,
  ANSWER     STRING,
  STEPS      VARIANT,
  MODEL      STRING,
  INPUT_TOKENS NUMBER, OUTPUT_TOKENS NUMBER, LATENCY_MS NUMBER
) COMMENT = 'One row per agent run: every tool call, SQL query and citation (audit trail)';

-- ---------------------------------------------------------------- account health (deterministic signals the agent verifies against)
CREATE OR REPLACE VIEW ACME.PULSE.ACCOUNT_HEALTH COPY GRANTS
  COMMENT = 'Per paying account: ARR, renewal, usage trend, ticket pressure and overdue commitments. As of 2026-10-22.'
AS
WITH params AS (SELECT '2026-10-22'::DATE AS as_of),
usage AS (
  SELECT e.WORKSPACE_ID,
    COUNT_IF(e.EVENT_TIME >= DATEADD(day, -13, p.as_of)) AS events_last_14d,
    COUNT_IF(e.EVENT_TIME >= DATEADD(day, -55, p.as_of) AND e.EVENT_TIME < DATEADD(day, -13, p.as_of)) / 3.0 AS events_prior_14d_avg,
    COUNT(DISTINCT IFF(e.EVENT_TIME >= DATEADD(day, -13, p.as_of), e.USER_ID, NULL)) AS active_users_last_14d
  FROM ACME.PULSE.EVENTS e, params p
  WHERE e.EVENT_TIME >= DATEADD(day, -55, p.as_of)
  GROUP BY e.WORKSPACE_ID
),
tix AS (
  SELECT t.WORKSPACE_ID,
    COUNT(*) AS tickets_30d,
    COUNT_IF(t.PRIORITY IN ('urgent', 'high')) AS urgent_tickets_30d,
    COUNT_IF(t.STATUS = 'open') AS open_tickets,
    AVG(t.CSAT) AS avg_csat_30d
  FROM ACME.PULSE.SUPPORT_TICKETS t, params p
  WHERE t.CREATED_AT >= DATEADD(day, -29, p.as_of)
  GROUP BY t.WORKSPACE_ID
),
commits AS (
  SELECT c.ACCOUNT,
    COUNT_IF(c.STATUS <> 'done' AND c.DUE_DATE < p.as_of) AS overdue_commitments,
    COUNT_IF(c.STATUS <> 'done') AS open_commitments
  FROM ACME.BRAIN.COMMITMENTS c, params p
  GROUP BY c.ACCOUNT
)
SELECT
  w.WORKSPACE_ID, w.NAME AS ACCOUNT, w.PLAN, w.REGION, w.CSM,
  w.MRR_USD * 12 AS ARR_USD,
  w.RENEWAL_DATE,
  DATEDIFF(day, p.as_of, w.RENEWAL_DATE) AS DAYS_TO_RENEWAL,
  COALESCE(u.events_last_14d, 0) AS EVENTS_LAST_14D,
  ROUND(u.events_prior_14d_avg) AS EVENTS_PRIOR_14D_AVG,
  ROUND(100 * (COALESCE(u.events_last_14d, 0) - u.events_prior_14d_avg) / NULLIF(u.events_prior_14d_avg, 0), 1) AS USAGE_CHANGE_PCT,
  COALESCE(u.active_users_last_14d, 0) AS ACTIVE_USERS_LAST_14D,
  COALESCE(t.tickets_30d, 0) AS TICKETS_30D,
  COALESCE(t.urgent_tickets_30d, 0) AS URGENT_TICKETS_30D,
  COALESCE(t.open_tickets, 0) AS OPEN_TICKETS,
  ROUND(t.avg_csat_30d, 2) AS AVG_CSAT_30D,
  COALESCE(c.overdue_commitments, 0) AS OVERDUE_COMMITMENTS,
  COALESCE(c.open_commitments, 0) AS OPEN_COMMITMENTS
FROM ACME.PULSE.WORKSPACES w
CROSS JOIN params p
LEFT JOIN usage u ON u.WORKSPACE_ID = w.WORKSPACE_ID
LEFT JOIN tix t ON t.WORKSPACE_ID = w.WORKSPACE_ID
LEFT JOIN commits c ON c.ACCOUNT = w.NAME
WHERE w.PLAN <> 'Free' AND w.CHURNED_AT IS NULL;
