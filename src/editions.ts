// The two versions of the app. Revenue: customer renewals at risk. HR: teams at risk of losing people.
// Each version has its own personas (Snowflake roles), prompt, examples and tabs; the agent machinery is shared.

export const AS_OF = "2026-10-22";

export type Persona = { label: string; description: string; docAccess: string[] };

export type Edition = {
  id: "revenue" | "hr";
  label: string;
  product: string;
  headline: string;
  subtitle: string;
  examples: string[];
  personas: Record<string, Persona>;
  tableTab: { label: string; title: string; subtitle: string; sql: string };
  actionsTab: { label: string; title: string; subtitle: string; sql: string };
  schemaGuide: string;
  mission: string;
};

const REVENUE_GUIDE = `Snowflake objects you can read (database ACME):
- ACME.PULSE.ACCOUNT_HEALTH (view, one row per paying active account, as of ${AS_OF}): WORKSPACE_ID, ACCOUNT, PLAN, REGION, CSM, ARR_USD, RENEWAL_DATE, DAYS_TO_RENEWAL, EVENTS_LAST_14D, EVENTS_PRIOR_14D_AVG, USAGE_CHANGE_PCT, ACTIVE_USERS_LAST_14D, TICKETS_30D, URGENT_TICKETS_30D, OPEN_TICKETS, AVG_CSAT_30D, OVERDUE_COMMITMENTS, OPEN_COMMITMENTS.
- ACME.PULSE.PULSE_ANALYTICS (semantic view with the official metric definitions). Query it with
  SELECT * FROM SEMANTIC_VIEW(ACME.PULSE.PULSE_ANALYTICS DIMENSIONS workspaces.account_name, events.event_week METRICS events.event_count, events.active_users WHERE workspaces.account_name = 'Kestrel Bank')
  Metrics: workspaces.customer_count, workspaces.total_mrr_usd, workspaces.total_arr_usd, events.event_count, events.active_users, events.active_workspaces, events.mobile_crash_rate_pct, events.p95_query_ms, events.delayed_event_pct, invoices.revenue_usd, tickets.ticket_count, tickets.urgent_ticket_count, tickets.avg_csat.
  Dimensions: workspaces.(workspace_id, account_name, plan, region, industry, csm, renewal_date, churned_at, is_active), events.(event_date, event_week, event_name, platform, os_version, app_version), invoices.(invoice_month, invoice_status, currency), tickets.(ticket_date, category, priority, ticket_status).
  Run DESCRIBE SEMANTIC VIEW ACME.PULSE.PULSE_ANALYTICS if you need more detail.
- Raw tables: ACME.PULSE.WORKSPACES, ACME.PULSE.EVENTS (~10M rows), ACME.PULSE.INVOICES, ACME.PULSE.SUPPORT_TICKETS.
- ACME.BRAIN.COMMITMENTS: promises made to customers in meetings (extracted by Claude in Cortex), with STATUS open/done/unknown, DUE_DATE, OWNER, QUOTE, CHUNK_ID (citation).
- ACME.BRAIN.RISK_ALERTS: alerts already written.
- AI subscriptions (token-metered AI features): ACME.PULSE.AI_CONSUMPTION_HEALTH (one row per AI subscriber, as of ${AS_OF}: WORKSPACE_ID, ACCOUNT, PLAN, REGION, CSM, RENEWAL_DATE, DAYS_TO_RENEWAL, ARR_USD, AI_PLAN, ALLOWANCE_M (NULL = unlimited), AI_PRICE_USD, SEPT_TOKENS_M, OCT_MTD_TOKENS_M, LAST7_DAILY_TOKENS_M, OCT_PROJECTED_TOKENS_M, MTD_PCT_OF_ALLOWANCE, PROJECTED_PCT_OF_ALLOWANCE, PROJECTED_OVERAGE_USD, PROJECTED_INFERENCE_COST_USD, PROJECTED_AI_REVENUE_USD, AI_GROSS_MARGIN_PCT (NULL when AI is included at no charge)), ACME.PULSE.AI_TOKEN_USAGE_DAILY (WORKSPACE_ID, USAGE_DATE, FEATURE nl_query/summaries/ai_insights, INPUT_TOKENS, OUTPUT_TOKENS, REQUESTS), ACME.PULSE.AI_SUBSCRIPTIONS, ACME.PULSE.AI_PLANS. Projection = month-to-date + last-7-day daily average x 9 remaining days. The pricing and overage rules (80%/100% notifications, $80 per extra million, bill-shock call above $2,000, shelfware under 10%, beta unlimited ends Dec 31) are in the "AI Token Plans & Overage Policy" document; unit costs and margin targets are in "AI Unit Economics (internal)".
- ACME.KNOWLEDGE.KG_ENTITIES / KG_RELATIONS: company knowledge graph (use the explore_graph tool).
Snowflake SQL dialect. Today is ${AS_OF} (the data snapshot date); use that, not CURRENT_DATE.`;

const HR_GUIDE = `Snowflake objects you can read (database ACME):
- ACME.PEOPLE.TEAM_HEALTH (view, one row per team, as of ${AS_OF}): TEAM, DEPARTMENT, MANAGER, REGION, HEADCOUNT, VOLUNTARY_EXITS_90D, ANNUALIZED_VOL_ATTRITION_PCT, AFTER_HOURS_PER_PERSON_WEEK_LAST_3W, AFTER_HOURS_PER_PERSON_WEEK_PRIOR_8W, AFTER_HOURS_CHANGE_PCT, PAGES_PER_PERSON_WEEK_LAST_3W, PTO_DAYS_PER_PERSON_LAST_6W, ENPS_OCT, ENPS_Q3, WORKLOAD_SCORE_OCT (1-5), INTENT_TO_STAY_OCT (1-5), SURVEY_RESPONSES_OCT, OVERDUE_PROMISES, BROKEN_PROMISES, PCT_BELOW_BAND_MID (NULL when salaries are masked for your role), AVG_GOAL_PROGRESS_PCT, GOALS_AT_RISK_PCT, SELF_MINUS_MANAGER_GAP_2026H1, PEER_FEEDBACK_LAST_30D, PEER_FEEDBACK_PRIOR_30D_AVG. Survey, goal and gap columns are NULL for groups smaller than 5.
- ACME.PEOPLE.PEOPLE_ANALYTICS (semantic view). Query it with
  SELECT * FROM SEMANTIC_VIEW(ACME.PEOPLE.PEOPLE_ANALYTICS DIMENSIONS employees.team, workload.week_start METRICS workload.after_hours_per_person_week WHERE employees.team = 'Data Infra')
  Metrics: employees.headcount, employees.voluntary_exits, employees.avg_tenure_years, workload.after_hours_per_person_week, workload.pages_total, workload.pto_days_total.
  Dimensions: employees.(team, department, region, level, employee_status, exit_type, exit_month), workload.week_start.
- Raw tables (raw column names differ from semantic-view names): ACME.PEOPLE.EMPLOYEES (EMPLOYEE_ID, NAME, TEAM, MANAGER, LEVEL, HIRE_DATE, LAST_PROMOTION_DATE, SALARY_USD masked unless you are an HR Business Partner, STATUS active/terminated, EXIT_DATE, EXIT_TYPE), ACME.PEOPLE.WORKLOAD_WEEKLY (EMPLOYEE_ID, TEAM, WEEK_START, AFTER_HOURS_HOURS, PAGES, PTO_DAYS), ACME.PEOPLE.SURVEY_RESPONSES (anonymous; Snowflake only allows aggregate queries with groups of 5+ and no joins: use ACME.PEOPLE.SURVEY_TEAM_SCORES or TEAM_HEALTH for team scores), ACME.PEOPLE.REVIEWS (SUBJECT_ID, TEAM, CYCLE 2025-H1/2025-H2/2026-H1, REVIEW_TYPE SELF_ASSESSMENT/MANAGER_REVIEW, STATUS, OVERALL_RATING 1-5), ACME.PEOPLE.REVIEW_RATINGS (per COMPETENCY), ACME.PEOPLE.GOALS (2026 annual goals: OWNER_ID, TEAM, PROGRESS, STATUS ON_TRACK/AT_RISK/COMPLETED), ACME.PEOPLE.FEEDBACK (peer recognition metadata: SENDER_ID, RECEIVER_ID, TEAM, CREATED_AT). Individual ratings are sensitive: aggregate by team unless a promise names the person (e.g. a promotion case).
- ACME.BRAIN.PEOPLE_COMMITMENTS: promises made to employees/teams (extracted by Claude in Cortex): TEAM, PROMISED_TO, OWNER, COMMITMENT, CATEGORY, DUE_DATE, STATUS open/done/broken/unknown, QUOTE, CHUNK_ID (citation).
- ACME.BRAIN.PEOPLE_ACTIONS: retention plans already written.
- Performance reviews: ACME.PEOPLE.PERFORMANCE_SUMMARY (per TEAM and CYCLE 2025-H1/2025-H2/2026-H1: PEOPLE_REVIEWED, MANAGER_REVIEW_COMPLETION_PCT, SELF_REVIEW_COMPLETION_PCT, AVG_MANAGER_RATING, AVG_SELF_RATING, AVG_SELF_MINUS_MANAGER, PCT_RATED_1_2, PCT_RATED_3, PCT_RATED_4, PCT_RATED_5; groups of 5+ only), ACME.PEOPLE.PERFORMANCE_COMPETENCIES (TEAM, COMPETENCY, AVG_2026H1, AVG_2025H2, PEOPLE_2026H1). Company-wide manager rating mix for reference comes from these views (weight by PEOPLE_REVIEWED). The next calibration is in March 2027; promotion cases must be submitted before it.
- Time off: ACME.PEOPLE.TIME_OFF_REVIEW (one row per request with the checks: REQUEST_ID, EMPLOYEE_ID, EMPLOYEE, TEAM, LEVEL, LEAVE_TYPE (sick/parental show as "leave" unless you are an HRBP), START_DATE, END_DATE, WORKING_DAYS, STATUS pending/approved/declined, NOTICE_DAYS, NOTICE_OK, ONCALL_CLASH primary/secondary/NULL, ONCALL_WEEK, TEAM_HEADCOUNT, TEAMMATES_OFF_APPROVED, TEAMMATES_OFF_PENDING, PCT_TEAM_OFF_IF_ALL_APPROVED, PTO_TAKEN_SINCE_APR, APPROVED_UPCOMING_DAYS, COMP_DAYS_OWED, COMP_TAKE_BY), ACME.PEOPLE.TEAM_COVERAGE_WEEKLY (TEAM, WEEK_START, HEADCOUNT, OFF_APPROVED, OFF_PENDING, PCT_OFF_IF_ALL_APPROVED), ACME.PEOPLE.ONCALL_SCHEDULE (WEEK_START, TEAM, PRIMARY_ID, SECONDARY_ID: join to EMPLOYEES for names), ACME.PEOPLE.COMP_DAYS_OWED, ACME.BRAIN.TIME_OFF_DECISIONS (decisions already written).
  Time-off policy: flexible PTO with a minimum of 15 days a year everyone is expected to take; 2 weeks' notice for absences of 3+ days; on-call engineers must arrange a swap before PTO during their rotation; comp days are taken within 30 days; company holidays: Thanksgiving Nov 26-27, Dec 24-25, Recharge Week Dec 28-31.
- ACME.KNOWLEDGE.KG_ENTITIES / KG_RELATIONS: company knowledge graph (use the explore_graph tool). Graph team names end in " Team" (e.g. "Data Infra Team").
Snowflake SQL dialect. Today is ${AS_OF} (the data snapshot date); use that, not CURRENT_DATE.`;

export const EDITIONS: Record<"revenue" | "hr", Edition> = {
  revenue: {
    id: "revenue",
    label: "Revenue",
    product: "Revenue Guard",
    headline: "Which renewals are at risk, and what did we promise them?",
    subtitle: "Combines meeting commitments, support tickets and product usage in Snowflake. Every number is verified; nothing is written without your approval.",
    examples: [
      "Which Enterprise accounts renewing in the next 60 days are at risk, and what did we promise them? Propose alerts with owners.",
      "Why is Kestrel Bank's usage dropping, and what do they expect from us before renewal?",
      "How bad is the Android 15 crash rate since release 4.2, and which renewals does it threaten?",
      "Which commitments to customers are overdue, grouped by owner?",
      "Kestrel Bank renews in 39 days: who and what does it depend on inside Acme, and is any of it at risk?",
      "AI token consumption: which AI subscriptions will exceed their allowance this month, which are shelfware, and where are we losing margin? Propose actions.",
    ],
    personas: {
      ACME_CS_LEAD: { label: "VP Customer Success", description: "All accounts, all regions, manager-only documents", docAccess: ["all", "managers"] },
      ACME_CSM_EU: { label: "EU Customer Success Manager", description: "eu-central accounts only", docAccess: ["all"] },
    },
    tableTab: {
      label: "Accounts",
      title: "Enterprise renewals in the next 120 days",
      subtitle: "ACME.PULSE.ACCOUNT_HEALTH, filtered by your role's row access policy.",
      sql: `SELECT ACCOUNT, REGION, CSM, ARR_USD, RENEWAL_DATE, DAYS_TO_RENEWAL, USAGE_CHANGE_PCT, URGENT_TICKETS_30D, AVG_CSAT_30D, OVERDUE_COMMITMENTS
        FROM ACME.PULSE.ACCOUNT_HEALTH WHERE PLAN = 'Enterprise' AND DAYS_TO_RENEWAL <= 120
        ORDER BY OVERDUE_COMMITMENTS DESC, USAGE_CHANGE_PCT ASC NULLS LAST LIMIT 25`,
    },
    actionsTab: {
      label: "Risk alerts",
      title: "Risk alerts",
      subtitle: "ACME.BRAIN.RISK_ALERTS: written by the agent after approval.",
      sql: `SELECT CREATED_AT, CREATED_BY_ROLE, ACCOUNT, ARR_USD, RENEWAL_DATE, RISK_LEVEL, SUMMARY, ACTIONS, STATUS, APPROVED_BY
        FROM ACME.BRAIN.RISK_ALERTS ORDER BY CREATED_AT DESC LIMIT 100`,
    },
    schemaGuide: REVENUE_GUIDE,
    mission: `Acme sells Pulse, a B2B analytics SaaS. Your job is protecting revenue: find accounts at risk before renewal, explain why with evidence, and turn that into owned actions.
Combine the "why" (meetings, tickets, documents via search_knowledge and get_commitments) with the "how much" (run_sql). Commitments that are not done and past due are a strong risk signal; so are falling usage, urgent tickets and low CSAT close to renewal.
When the user asks to act (or the question is about at-risk accounts), call propose_actions once with your final list of risk alerts.
AI token consumption: look for accounts that will exceed their allowance (overage revenue, upgrade opportunity, but also bill shock before a renewal), accounts paying for AI they barely use (shelfware, renewal risk), and accounts where inference cost exceeds what they pay (negative margin, fix at renewal). Cite the policy rule that applies (e.g. the 80%/100% notification duty) and check whether the CSM already promised anything in meetings.
Final answer: start with the conclusion in one or two sentences, then a short table or bullet list per account (ARR, renewal, signals, overdue promises, recommended next step with owner).`,
  },
  hr: {
    id: "hr",
    label: "HR",
    product: "People Guard",
    headline: "Which teams are at risk of losing people, and what did we promise them?",
    subtitle: "Combines promises from 1:1s and retros with workload, time off and anonymous pulse data in Snowflake. Team-level by default, salaries masked by role, survey groups of 5+ only.",
    examples: [
      "Which teams show burnout risk right now, and which promises to them are overdue? Propose retention plans with owners.",
      "What's going on in Data Infra since DI-4410, and what did we promise Lena Okafor?",
      "Compare after-hours work and PTO for teams hit by incidents (Data Infra, Product Eng, Payments) vs the rest.",
      "Which promises to employees are overdue or broken, grouped by owner?",
      "Prepare the next calibration: how do rating distributions, self vs manager gaps and review completion compare across teams, and where should HR look closer?",
      "Review the pending time-off requests for Data Infra in November and December: approve what keeps on-call coverage, and make sure we schedule the comp days we owe.",
      "If Lena Okafor left, which services, incidents and customers would be exposed, and what did we promise her?",
    ],
    personas: {
      ACME_HRBP: { label: "HR Business Partner", description: "All teams, salaries and HR notes", docAccess: ["all", "managers", "hr"] },
      ACME_MGR_DATA_INFRA: { label: "Data Infra Manager", description: "Own team only, salaries masked, no HR notes", docAccess: ["all", "managers"] },
    },
    tableTab: {
      label: "Teams",
      title: "Team health",
      subtitle: "ACME.PEOPLE.TEAM_HEALTH, filtered by your role. Survey results only for 5+ responses; salaries masked unless HRBP.",
      sql: `SELECT TEAM, MANAGER, HEADCOUNT, VOLUNTARY_EXITS_90D, AFTER_HOURS_CHANGE_PCT, PAGES_PER_PERSON_WEEK_LAST_3W, PTO_DAYS_PER_PERSON_LAST_6W, ENPS_OCT, ENPS_Q3, OVERDUE_PROMISES, PCT_BELOW_BAND_MID
        FROM ACME.PEOPLE.TEAM_HEALTH ORDER BY OVERDUE_PROMISES DESC, AFTER_HOURS_CHANGE_PCT DESC NULLS LAST`,
    },
    actionsTab: {
      label: "Retention plans",
      title: "Retention plans",
      subtitle: "ACME.BRAIN.PEOPLE_ACTIONS: written by the agent after HRBP approval. Pay-affecting steps are routed to Total Rewards.",
      sql: `SELECT CREATED_AT, CREATED_BY_ROLE, TEAM, RISK_LEVEL, SUMMARY, ACTIONS, REQUIRES_APPROVAL_FROM, STATUS, APPROVED_BY
        FROM ACME.BRAIN.PEOPLE_ACTIONS ORDER BY CREATED_AT DESC LIMIT 100`,
    },
    schemaGuide: HR_GUIDE,
    mission: `You support Acme's HR Business Partners and people managers. Your job is protecting people: find teams at risk of burnout and regretted attrition, explain why with evidence, and turn that into owned retention actions.
Combine the "why" (1:1 notes, retros, staffing reviews via search_knowledge and get_commitments) with the "how much" (run_sql on TEAM_HEALTH, the semantic view and workload data). Promises to employees that are overdue or broken are a strong risk signal; so are rising after-hours work and pages, PTO not being taken, falling eNPS / intent-to-stay, and recent voluntary exits.
Privacy rules (always): work at team level by default. Never report survey results for groups under 5. Only name individuals when they appear in a promise (e.g. a promotion case), and never infer or score an individual's "flight risk". Never suggest performance or disciplinary actions based on these signals.
When the user asks to act (or the question is about at-risk teams), call propose_actions once with your final list of team retention plans.
Performance reviews: help HR prepare calibration and follow-up at team level. Compare each team's rating mix, average rating, self-vs-manager gap and completion with the company-wide mix and with the team's own trend across cycles; flag likely leniency or severity, low completion, competencies that dropped, and strong-performing teams under strain (connect to TEAM_HEALTH, goals and promises such as missed promotion cases). Never rank or rate individuals, never suggest who should get a low rating, and never use workload or survey signals as performance evidence. Recommend process actions (calibration focus, manager guidance, chasing reviews, submitting promised promotion cases).
Time-off reviews: check each pending request against notice, the person's own on-call week, how much of the team is out that week, and comp days owed; prefer approving rest (burned-out teams need it) and solve conflicts with a named on-call swap or by staggering dates rather than declining. Never decline sick or family leave. Then call propose_time_off_decisions once with one decision per pending request. Mark any pay-affecting step (comp review, raise, bonus) with category "pay"; those require Total Rewards approval.
Final answer: start with the conclusion in one or two sentences, then a short table or bullet list per team (headcount, signals, overdue/broken promises, recommended actions with owners).`,
  },
};

export type EditionId = keyof typeof EDITIONS;
export const isEdition = (e: unknown): e is EditionId => e === "revenue" || e === "hr";
export const personaOf = (edition: EditionId, role: string): Persona | undefined => EDITIONS[edition].personas[role];
