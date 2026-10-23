# Submission: Ingestion · SignalHR

**Repo:** https://github.com/rgarciasf/ingestion-snowflake
**Team:** Rafael Garcia (Innova Soluciones IT)
**Track:** Internal (make the business run better)

> The Revenue version (renewals and AI token consumption) is on hold. Its code and data stay in the repo, but the app offers only the HR version (`ENABLED_EDITIONS=hr`).

---

## 1. Value case (paste into "Value case")

**One line:** An HR agent on governed Snowflake data that finds which teams are about to burn out or break, and which promises we made them. It approves time off without breaking coverage and prepares performance calibration. It proves every number, never profiles individuals, and acts only with a human's approval.

**Who it's for:** HR Business Partners and people managers.

**The problem.** The signals that predict regretted attrition are spread across systems: pager logs, after-hours work, time not taken, pulse surveys, reviews and goals. The promises managers make in 1:1s and retros sit in notes nobody tracks. HR finds out when someone resigns.

**What it does (demonstrated today on a fictional company, Acme), in three cases:**

1. **Teams at risk.** *"Which teams are at risk of losing people, and what did we promise them?"*
   - It flagged Data Infra: eNPS fell from +15 to −85, after-hours work rose 171%, 2 people left voluntarily, 4 promises to the team are overdue and 1 is broken.
   - It flagged Product Eng: eNPS fell from +50 to −71, and the "no weekend work" promise was broken.
   - It proposed retention plans with owners and dates, and routed the one pay step to Total Rewards.
2. **Time off.** *"Review the pending requests: approve what keeps on-call coverage, and schedule the comp days we owe."*
   - 9 requests reviewed; 4 on-call clashes solved with 2 named swaps.
   - A promised week off approved as a one-day notice exception.
   - Someone under the 15-day PTO minimum flagged.
   - All 23 owed comp days scheduled before their deadline.
   - Decisions written to Snowflake after the manager approved.
3. **Performance reviews.** *"Where should the next calibration look closer?"*
   - Low completion: Finance at 75%, Product Eng at 83%.
   - Possible leniency: Design gives 50% 5s and never a 3.
   - Possible severity: Product Management dropped from 4.57 to 3.50.
   - A strong-performing team under strain: Data Infra, whose promised promotion case was missed.
   - It works at team level only and never ranks or rates individuals.

**Why it matters.** Weeks of spreadsheet work become a verified answer in a minute or two, with owners and dates, written back to Snowflake so they can be tracked.

---

## 2. Architecture summary (paste into "Architecture")

- **Snowflake is the governed source of truth.**
  - `ACME.PEOPLE` holds the workforce, weekly workload, anonymous pulse surveys, reviews, competency ratings, goals, feedback, time-off requests, the on-call schedule and comp days owed.
  - Views compute the signals: `TEAM_HEALTH`, `TIME_OFF_REVIEW`, `TEAM_COVERAGE_WEEKLY`, `PERFORMANCE_SUMMARY` and `PERFORMANCE_COMPETENCIES`, plus the `PEOPLE_ANALYTICS` semantic view.
  - **Cortex Search** indexes 1:1s, retros, staffing notes and HR policies.
  - A **knowledge graph** (recursive CTEs) answers *"If Lena Okafor left, which services and incidents would be exposed?"*
- **Claude does the reasoning, in three roles.**
  1. **Claude Opus 5.5** is the investigator. Its tools are `run_sql`, `search_knowledge`, `get_commitments`, `explore_graph`, `verify_numbers`, `propose_actions` and `propose_time_off_decisions`.
  2. **Claude Sonnet 5.5** is the independent verifier. It re-derives every key number with its own SQL. In testing it rejected 2 of 14 numbers in one run, and they were corrected before the answer.
  3. **Claude in Cortex (`AI_COMPLETE`, structured JSON)** reads every HR note and extracts each promise to an employee or team. Each promise has an owner, category, due date, quote and a status (open, done, broken) taken from later follow-up notes.
- **Humans approve every write.** Retention plans go to `PEOPLE_ACTIONS` and time-off decisions to `TIME_OFF_DECISIONS`. Pay steps are routed to Total Rewards, and every run is logged in `AGENT_TRACES`.
- **Governance is enforced by Snowflake, not the app.**
  - The HRBP sees all teams. A manager sees only their own team, by row access policy.
  - Salaries are masked for non-HRBPs, and sick or parental leave shows as "leave".
  - Anonymous survey answers can only be read in groups of 5+, by aggregation policy.
  - HR notes are visible to HRBPs only.

Diagram: `docs/architecture-hr.html`.

---

## 3. Build story (paste into "Build story")

We started from our earlier project, Ingestion, a company-brain agent on ClickHouse. Today we rebuilt the idea from scratch on Snowflake for one user: the HR Business Partner. We added three concrete cases with measurable outcomes. All code, SQL and data in the repo were written during the event. (We also built a Revenue version for customer renewals and AI token usage, now on hold, so we could focus.)

**What we built today:**
- A 187-person synthetic workforce whose story matches the incidents in the company's documents.
- HR notes with promises, extracted by Claude in Cortex.
- Five Snowflake policies.
- The agent with two models.
- A SaaS-style web app.

**What we learned:**
1. **Governance can fail silently.** At first a manager could see all 14 teams and every salary, because the hackathon user has every role active as secondary roles, ACCOUNTADMIN included. Each persona session now runs `USE SECONDARY ROLES NONE`, and the manager sees 1 team with salaries masked.
2. **The aggregation policy works as designed.** It blocked our own team-health view from joining raw survey rows, so team scores are pre-aggregated with the 5+ rule built in.
3. **Cortex Search runs with owner's rights.** We added row access on the chunk table and a per-persona search filter, so a manager can't read a 1:1 note through a citation.
4. **The verifier earns its place.** It caught numbers that didn't hold before HR saw them.
5. **Real HR data was used safely.** The shape of the performance data comes from **aggregate-only statistics** of a real HR system: rating distributions, the self vs manager gap and completion rates. They were computed read-only inside the source database, with groups under 5 suppressed and no names, IDs or text. That profile is never published. Every person in the repo is fictional.

---

## 4. Viability (paste into "Viability")

- **Runs where the data already is.** It deploys into a company's own Snowflake. Personas map to existing roles, so there is no data copy and no new permission model.
- **Inputs are things HR already has:** the HRIS (Ascend, Workday), performance and goals, pulse surveys, pager and PTO systems, and 1:1 notes.
- **Next steps:**
  - an HRIS connector (aggregate-first, same policies);
  - meeting-notes ingestion (Granola, Zoom, Teams);
  - a scheduled weekly "teams at risk" digest for each HRBP.
- **Cost per investigation:** roughly 80K–140K tokens (about $0.40–$0.80 at Opus 5.5 pricing). Compare that with hours of HRBP and manager time.
- **Responsible by design:**
  - team-level analysis, with no individual flight-risk scores;
  - signals are never used for performance or disciplinary decisions;
  - sick and family leave is never declined;
  - every number is cited and independently verified;
  - every write is approved by a human and auditable.

## 5. Tools used

Snowflake (Cortex Search, Cortex `AI_COMPLETE` with Claude, semantic views, row access, masking and aggregation policies, recursive CTEs, GENERATOR) · Claude API (Claude Opus 5.5, Claude Sonnet 5.5, tool use, adaptive thinking, server-side refusal fallback) · Claude Code (built the project) · Node.js 24 + TypeScript · `@anthropic-ai/sdk` · `snowflake-sdk` · GitHub

---

## 6. One-minute demo video: shot-by-shot script

**Rules:** show only what was built today, no slides. **Recording:** use QuickTime screen recording at 1280×800. Pre-run the long questions and speed them up 6–8× in iMovie. Record the voice-over separately.

| Time | On screen | Voice-over (about 150 words in total) |
|---|---|---|
| 0:00–0:06 | SignalHR **Overview**: KPI cards, the Data Infra card in red | "Data Infra has been paged every night for three weeks. Their eNPS fell from plus 15 to minus 85, two engineers quit, and the promises we made them are overdue." |
| 0:06–0:20 | **Ask the agent** as the HR Business Partner → first example. The trace fills in, sped up: team health, Cortex Search over 1:1s, promises, *Sonnet verifier* | "SignalHR connects the signals in Snowflake with the promises in our 1:1 notes, and a second Claude re-checks every number." |
| 0:20–0:26 | Click a blue **doc** chip: the retro line where the promise was made. Then an orange **q** chip: the SQL | "Every promise links to the moment it was made. Every number links to its query." |
| 0:26–0:31 | **Approval card**: the pay step shows "needs Total Rewards" → *Approve & write* | "Nothing is written until HR approves, and pay changes go to Total Rewards." |
| 0:31–0:44 | Switch persona to the **Data Infra Manager** → time-off example (sped up) → the decisions table with on-call swaps → Approve | "Managers get the same help. It reviews time off against on-call coverage, proposes swaps, and schedules the comp days we owe." |
| 0:44–0:50 | Ask for salaries and the 1:1 notes as the manager → the agent says they're masked and hidden | "And Snowflake decides who sees what. This manager can't see salaries or anyone's 1:1." |
| 0:50–0:56 | Quick cut: the calibration answer (Design 50% rated 5, Finance 75% completion) | "It even prepares performance calibration, at team level, never rating individuals." |
| 0:56–1:00 | Overview, with the repo URL as a caption | "Snowflake governs. Claude reasons and verifies. People decide." |

**Before recording:**
- [ ] The app runs at http://localhost:3100. Restart it with `PORT=3100 node --env-file=.env src/server.ts`.
- [ ] Pre-run the three questions (teams at risk, time off, calibration) so you know the timing.
- [ ] Browser zoom at 90% so the trace panel is visible. Close other tabs and turn on Do Not Disturb.
- [ ] Upload to YouTube (unlisted) or Loom, and check the link in a private window.

---

## 7. Three-minute pitch (Round 1, 4:45 PM; Round 2, 6:30 PM)

**0:00–0:30 Hook.**
"HR usually finds out a team is burning out when someone resigns. The signals were there: pager logs, after-hours work, time off not taken, a falling pulse score. So were the promises managers made in 1:1s and retros, and nobody tracked them. At Acme, Data Infra's eNPS went from +15 to −85 in a month, two engineers quit, and four promises to the team are overdue."

**0:30–2:20 Live demo (most of the time).**
1. As the HRBP, ask the teams-at-risk question. Show the trace, point at the verifier, and click a citation into the retro (45 s).
2. Approve the retention plan. The pay step is routed to Total Rewards (15 s).
3. Switch to the Data Infra Manager and run the time-off review: swaps, comp days, approve (35 s).
4. As the manager, ask for salaries and 1:1 notes. Snowflake says no (15 s).

*Backup: if a live run is slow, show a pre-run result from the same session.*

**2:20–3:00 Impact and what's next.**
"A verified answer in a minute or two, with owners and dates, written back to Snowflake, instead of finding out at the exit interview. It runs inside the company's own Snowflake under their existing roles, so it's deployable on day one. Next: HRIS connectors and a weekly digest for every HRBP."

**Likely Q&A (keep answers short):**
- *Isn't this employee surveillance?* No. It works at team level, has no individual risk scores, reads survey data only in groups of 5+, and its signals are never used for performance or discipline. Its job is to make managers keep their promises and protect rest time.
- *How do you stop hallucinated numbers?* Every number comes from SQL, a second model re-derives it, and the UI links to the exact query.
- *Is the HR data real?* No. Every person is fictional. The shape of the performance data comes from aggregate-only statistics of a real HR system, groups under 5 suppressed, never published.
- *Why Snowflake and Claude together?* Snowflake enforces privacy at the data layer (row access, masking, aggregation policies). Claude does the multi-step reasoning, and extraction inside Snowflake via Cortex `AI_COMPLETE`.
