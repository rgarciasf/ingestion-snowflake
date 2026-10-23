# Ingestion · Revenue Guard + People Guard (on Snowflake)

**Find what is about to break, revenue or people, and what we promised, before anyone notices.**

The warning signs live in different systems. The promise made on a call lives in a transcript, the usage drop in the warehouse, the angry tickets in the support desk, and the burnout in pager logs and time-off requests. Today someone reviews these by hand, weekly at best, and promises slip.

This app is one agent with two versions, connected to **Snowflake** and powered by **Claude**:

| | **Revenue** (Revenue Guard) | **HR** (People Guard) |
|---|---|---|
| User | VP Customer Success | HR Business Partner, people manager |
| Cases | **Renewals at risk**: which renewals are at risk, and what did we promise them?<br>**AI token consumption**: who will exceed their AI allowance, who pays for AI they don't use, and where are we losing margin? | **Teams at risk**: which teams are at risk of losing people, and what did we promise them?<br>**Time off**: which pending requests can we approve without breaking on-call coverage, and which comp days do we owe?<br>**Performance reviews**: where should calibration look closer: rating mix, self vs manager gaps, completion? |

For every case the agent does the same five things:

1. **Find:** queries Snowflake under the user's own role (semantic views, health views, raw tables).
2. **Explain:** combines the numbers with the "why" (call transcripts, 1:1s and retros via Cortex Search, promises extracted by Claude in Cortex, and the knowledge graph), citing every claim.
3. **Verify:** a separate Claude verifier re-derives every key number with its own SQL before anything is proposed.
4. **Act:** proposes alerts, retention plans or time-off decisions with owners and dates, and writes them to Snowflake **only after a human approves**.
5. **Govern:** row access, masking and aggregation policies decide what each persona can see. They are enforced by Snowflake, not by the app.

> Inspired by **Ingestion**, our earlier company-brain project (ClickHouse-based). All code, SQL and new data in this repo were written during the Intelligence at Work hackathon (2026-10-23). The fictional "Acme" documents in `data/sources/` come from that project, except the new customer call notes, HR notes and the AI and time-off policies. All Snowflake data is newly generated and synthetic.

## The five cases

### Revenue · Renewals at risk
- **Data:** `ACCOUNT_HEALTH` (ARR, days to renewal, usage trend, urgent tickets, CSAT, overdue promises), the `PULSE_ANALYTICS` semantic view, and promises extracted from customer calls (`ACME.BRAIN.COMMITMENTS`).
- **Test run:** 4 of 66 Enterprise accounts renewing in the next 60 days are at risk, worth $301.8K ARR. Example: Kestrel Bank renews in 39 days, usage is down 36%, it has 18 urgent tickets, and the credit note it was promised is overdue. Alerts are written to `ACME.BRAIN.RISK_ALERTS`.

### Revenue · AI token consumption
- **Data:**
  - `AI_CONSUMPTION_HEALTH`: allowance, month-to-date and projected tokens, projected overage, inference cost and AI gross margin per subscriber;
  - `AI_TOKEN_USAGE_DAILY` and `AI_SUBSCRIPTIONS`;
  - the **AI Token Plans & Overage Policy** (80%/100% notifications, $80 per extra million tokens, a bill-shock call above $2,000, shelfware under 10%);
  - **AI Unit Economics** (internal, managers only).
- **Test run:**
  - **Nord Bank 19:** a $7,502 overage 34 days before renewal.
  - **Lumio Learning:** at 235% of its allowance.
  - **Brightline Health:** at 91%, and the agent found this one on its own.
  - **Kestrel Bank:** shelfware (3%).
  - **Bright Health 23:** −192% margin on beta "unlimited" pricing.
  - **Bonus:** 153 Growth AI Starter subscriptions sit below the 70% margin target.

### HR · Teams at risk
- **Data:**
  - `TEAM_HEALTH`: after-hours work, pages, PTO, eNPS and intent-to-stay (only for 5+ responses), exits, goal progress, the self vs manager rating gap, peer recognition, and overdue or broken promises;
  - the `PEOPLE_ANALYTICS` semantic view;
  - promises extracted from 1:1s and retros (`ACME.BRAIN.PEOPLE_COMMITMENTS`).
- **Test run:** Data Infra's eNPS went from +15 to −85, after-hours work rose 171%, 2 people left voluntarily, 4 promises are overdue and 1 is broken. Product Eng's eNPS went from +50 to −71. Retention plans are written to `ACME.BRAIN.PEOPLE_ACTIONS`, and pay steps are routed to Total Rewards.

### HR · Performance reviews (calibration prep)
- **Data:** `PERFORMANCE_SUMMARY` (per team and cycle: completion, manager rating mix, average self and manager rating, self-vs-manager gap) and `PERFORMANCE_COMPETENCIES` (per team and competency). Both cover groups of 5+ only, follow team row access, and come from the synthetic reviews whose shape follows aggregate-only statistics of a real HR system.
- **Test run (as the HRBP):**
  - **Baseline:** company average 3.92, 21% rated 5, 94% completion.
  - **Low completion:** Finance (75%) and Product Eng (83%).
  - **Possible leniency:** Design (50% rated 5, never a 3) and Platform (3.62 → 4.15).
  - **Possible severity or drift:** Product Management (4.57 → 3.50, largest self gap) and Support (down three cycles in a row).
  - **Strong team under strain:** Data Infra, whose promised promotion case is broken.
  - **Checking:** 9/9 figures verified.
- **Guardrails:** it never ranks or rates individuals, never uses workload or survey data as performance evidence, and only recommends process actions.

### HR · Time off
- **Data:**
  - `TIME_OFF_REVIEW`: one row per request, checking notice, the person's own on-call week, the share of the team out, comp days owed and PTO taken;
  - `TEAM_COVERAGE_WEEKLY`, `ONCALL_SCHEDULE` and `COMP_DAYS_OWED`;
  - the PTO and on-call recovery policies.
- **Test run (as the Data Infra Manager):** 9 pending requests. It solved 4 on-call clashes with 2 named swaps, approved Lena Okafor's promised week off as a one-day notice exception, flagged someone under the 15-day minimum, and scheduled all 23 owed comp days before their deadline. Decisions are written to `ACME.BRAIN.TIME_OFF_DECISIONS`.
- **Privacy:** sick and parental leave show as "leave" to anyone who isn't an HRBP (masking policy).

## Personas and governance

| Persona (Snowflake role) | Sees | Enforced by |
|---|---|---|
| VP Customer Success (`ACME_CS_LEAD`) | All 6,000 accounts, manager-only documents | `ACCOUNT_REGION_POLICY`, `DOC_ACCESS_POLICY` |
| EU Customer Success Manager (`ACME_CSM_EU`) | Only the 1,740 eu-central accounts (including AI usage and graph customers) | `ACCOUNT_REGION_POLICY` |
| HR Business Partner (`ACME_HRBP`) | All 14 teams, salaries, HR notes, leave types | `TEAM_POLICY` |
| Data Infra Manager (`ACME_MGR_DATA_INFRA`) | Own team only; salaries masked; no HR notes; sick and parental leave shown as "leave" | `TEAM_POLICY`, `SALARY_MASK`, `LEAVE_TYPE_MASK`, `DOC_ACCESS_POLICY` |
| Everyone | Survey answers only in aggregate, groups of 5+ | `SURVEY_MIN_GROUP` (aggregation policy) |

The app connects one session per persona with `USE SECONDARY ROLES NONE`, so no other granted role (such as ACCOUNTADMIN) can bypass the policies. Cortex Search runs with the owner's rights, so search results are also filtered per persona in the app, and the chunk table carries the document access policy.

**HR guardrails.** Analysis is team-level by default. There are no individual "flight risk" scores, and the signals are never used for performance or disciplinary decisions. Individuals are named only when they appear in a promise. Sick and family leave is never declined by the agent.

**HR performance data (reviews, competency ratings, goals, peer feedback).** It is synthetic, for the same fictional employees. Its shape follows a profile of **aggregate statistics** (rating distributions, the self vs manager gap, completion rates, goal shape, feedback rate) computed read-only inside a real HR system by `scripts/profile-ascend.ts`. Groups under 5 were suppressed, and no names, IDs, titles or text were read. Competency labels were replaced with generic names. The profile itself (`data/hr-profile.json`) is git-ignored and never published; only the generated synthetic SQL is in the repo.

## Architecture

```
                 ┌────────────────────── Claude Opus 5.5: investigator (Claude API) ──────────────────────┐
 question  ───▶  │ run_sql · search_knowledge · get_commitments · explore_graph · verify_numbers ·          │ ──▶ cited answer
 + persona       │ propose_actions · propose_time_off_decisions                                              │
                 └──────┬────────────────────┬────────────────────┬────────────────────┬──────────────────────┘
                        │                    │                    │                    │ approval card (human)
        Semantic + health views      Cortex Search          Claude Sonnet 5.5     INSERT into ACME.BRAIN
        PULSE_ANALYTICS, ACCOUNT_    KNOWLEDGE_SEARCH       verifier: own SQL     RISK_ALERTS · PEOPLE_ACTIONS ·
        HEALTH, AI_CONSUMPTION_      (docs, calls, HR       per claim             TIME_OFF_DECISIONS · AGENT_TRACES
        HEALTH, PEOPLE_ANALYTICS,    notes) + knowledge
        TEAM_HEALTH, TIME_OFF_REVIEW graph (recursive CTE)
                        └────────────── all under the persona's Snowflake ROLE ──────────────┘
                     row access (region, team) · masking (salary, leave type) · aggregation (survey ≥ 5)

 Offline, in Snowflake: AI_COMPLETE(claude-…) reads every customer call and HR note
                        → ACME.BRAIN.COMMITMENTS / PEOPLE_COMMITMENTS (owner, due date, quote, status, citation)
```

Diagrams: [docs/architecture.html](docs/architecture.html) (Revenue) and [docs/architecture-hr.html](docs/architecture-hr.html) (HR).

| Layer | Snowflake | Claude |
|---|---|---|
| Surface | Snowflake account, one role per persona | Web app (Node), agent loop on the Claude API, SaaS-style UI with Revenue and HR workspaces |
| Context | Semantic views, health views, Cortex Search over docs, calls and HR notes, knowledge graph | System prompt, schema guide, policy rules |
| Intelligence | `AI_COMPLETE` with Claude in Cortex (promise extraction) | Opus 5.5 investigates, Sonnet 5.5 verifies |
| Action | Governed write-back to `ACME.BRAIN.*`; traces in `AGENT_TRACES` | Human-in-the-loop approval cards |
| Trust | Row access, masking and aggregation policies; read-only SQL guard | Every number cited to a query; independent verification |

## Data (all synthetic, no PII)

- **`ACME.PULSE`:**
  - 6,000 workspaces, ~9.5M product events, invoices and ~28.5K support tickets (Apr–Oct 2026). Built-in stories: the Android 4.2 crash spike, the INC-2291 billing incident, the DI-4410 EU ingestion delays and the Reports v1 deprecation.
  - AI token plans, ~720 AI subscriptions, and 52 days of daily token usage per feature.
- **`ACME.PEOPLE`:** 187 employees in 14 teams, weekly workload (Apr–Oct), 3 anonymous pulse surveys, 3 review cycles, 2026 goals, peer feedback, ~130 time-off requests, the Nov–Dec on-call schedule and comp days owed.
- **`ACME.KNOWLEDGE`:** 42 documents and 181 search chunks (policies, product docs, tickets, customer calls, HR notes), plus a knowledge graph of 62 entities and 78 relations.
- **Story accounts and teams:**
  - Kestrel Bank, Cobalt Logistics, Nord Games, Atlas Retail, Brightline Health, Harbor Fintech, Lumio Learning, Fern Media, Nord Bank 19 and Bright Health 23;
  - Data Infra, Product Eng, Customer Success and Payments.

Their numbers match their call transcripts and HR notes.

## Setup

```bash
npm install
cp .env.example .env          # Snowflake account/user/password (or PAT) and ANTHROPIC_API_KEY
npm run knowledge             # regenerates snowflake/03_knowledge.sql from data/sources
npm run hr:data               # regenerates snowflake/hr/10, 11 and 15 (needs data/hr-profile.json)
npm run graph                 # regenerates snowflake/07_knowledge_graph.sql from data/graph*.json
npm run setup                 # runs snowflake/01..08 (Revenue) then snowflake/hr/10..17 (HR) as ACCOUNTADMIN
npm start                     # http://localhost:3000 (set PORT to change)
```

`06_commitments_claude.sql` and `hr/14_hr_commitments_claude.sql` use a Claude model through Cortex `AI_COMPLETE`. Set `CLAUDE_MODEL` at the top of each file to a Claude model available in your Snowflake region (tested with `claude-sonnet-4-5`). The governance scripts are re-runnable.

## Demo script

1. **Hook:** "Kestrel Bank renews in 39 days. Usage is down 36%, and three promises we made them are overdue. Nobody connected the dots."
2. **Revenue overview:** KPI cards and the accounts that need attention. Ask the renewals question and watch the trace (semantic-view SQL, Cortex Search, commitments, the **Sonnet verifier**).
3. **Citations:** click an orange **q** chip to see the SQL and rows, and a blue **doc** chip to see the transcript line.
4. **Approve** the alerts and open **Risk alerts**: they are now rows in Snowflake.
5. **Governance:** switch to the **EU CSM**. Only eu-central accounts come back, filtered by Snowflake.
6. **AI tokens:** ask the AI consumption question to show the $7,502 bill shock and the −192% margin account.
7. **HR:** switch versions and, as the **Data Infra Manager**, run the time-off review to show the swaps, the comp days and the approval. Then, as the **HR Business Partner**, ask which teams are at risk.
