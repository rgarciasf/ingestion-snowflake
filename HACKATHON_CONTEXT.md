# Intelligence at Work Hackathon (Snowflake × Anthropic): Context

Date: 2026-10-23 · SVAI Hub · Sources: Granola notes (kickoff + setup) and 36 slide photos

## Problem statement
Use Claude models and Snowflake surfaces to build a working solution that moves a business forward. It should be **measurable**, built **for a specific user**, and do **well beyond what a single prompt could reproduce**.
- Snowflake is the governed source of truth. Claude is the intelligence that turns that truth into decisions, actions, or experiences. Show how the two compound and complement each other.
- Track 01, **Internal**: make the business run better. Workflows that get people from question to decision faster, or that automate recurring multi-step work with fewer handoffs.
- Track 02, **External**: change what the business offers. New or reimagined products and customer experiences grounded in what the business actually knows.
- **Data** (in order of preference): (1) a non-production sample, a synthetic set, or an extract approved for an open event; (2) public data relevant to your company; (3) the fallback dataset that's provided. Core data lives in Snowflake. **Make governance visible.**
- ⚠️ No PII, sensitive data, or proprietary knowledge in the hackathon Snowflake accounts.

## Accounts
- One Snowflake account per team, with 6 built-in users (USER, USER2 … USER6). You can create more users. Facilitators can access accounts to help and to judge.
- Accounts are available until **Oct 27**, so export your work before then.

## Rules
- Only new work built during the event, and the demo must make clear what you built. Otherwise the project is disqualified.
- The GitHub repo must be **public**.
- Teams of at most 3. Solo is allowed.
- Projects that use code, data, or assets you don't have rights to are banned.

## Submission: due **4:30 PM today** on Cerebral Valley
- Value case, architecture summary, build story, viability, public GitHub repo, and tools used
- **1-minute demo video** (YouTube or Loom) that shows only what was built today
- **No slide presentations**

## Judging (100 pts)
| Pts | Criterion | Question |
|---|---|---|
| 35 | Impact | Long-term potential. Does it fit the problem statement? Is it useful, and for whom? |
| 30 | Demo | How well is it implemented? Does it work? |
| 25 | Creativity | Is it innovative? Is the approach non-obvious? |
| 10 | Craft with Snowflake & Claude | How deep does the use of both go, beyond one prompt? |

- **Round 1, 4:45 PM**: in front of a room of judges, 3 min pitch and demo, then 2 min Q&A
- **Round 2, 6:30 PM**: top 6 teams on the main stage, 3 min pitch, then 2 min Q&A
- Pitch: open strong (≤30 s: who has this problem and why it matters) → spend most of the time on a live demo → land the impact (results and what comes next). Keep Q&A answers short.

## Key ideas from the kickoff talk (Dylan Lockman, Anthropic Applied AI, and Snowflake)
- **Three things to remember**: (1) Autonomy unlocks value: agents own the job end to end. (2) Context × intelligence multiply: Snowflake context makes Claude sharper. (3) Trust is the shared foundation: model safety plus governed data.
- **Where intelligence pays off**: many steps and systems, a high cost of being wrong, humans reviewing everything today, decision authority that's about to be delegated, or a pilot that already stalled.
- **Five dimensions** (Snowflake / Both / Anthropic):
  - Surface: Snowsight, CoWork, CoCo (Cortex Code), Cortex Agents / embedded agents, API / Claude Cowork, Claude Code, Claude Design, Claude Tag
  - Context: Semantic layer (semantic views), Horizon Catalog, knowledge graph, RBAC, Iceberg / MCP, git, docs / CLAUDE.md, memories
  - Toolkit: Cortex Search, Cortex Analyst, Document AI / MCP, Skills, web search, plugins / Agent SDK, code execution, hooks
  - Intelligence: auto-mode model selection, AI Gateway routing / Claude in Cortex / Fable, Opus, Sonnet, Haiku, extended thinking, effort control
  - Action: governed write-back, Snowpark, alerts / API, MCP, sub-agents / computer use, artifacts
  - Cross-cutting: observability, evals, identity/auth, governance & security
- **Stoweaway Financial demo** (a fictional brokerage). The question was "Why is retention up?"
  1. Marketing analyst (Snowflake CoWork + Cortex Agent on a semantic view): found Campaign 31 as the driver. Customers who set up a recurring deposit within 30 days had a +38 pp retention gap and a 6× balance. The analyst certified the segment.
  2. Data scientist (CoCo + Claude Opus): designed an experiment and flagged a rollout to 10% of users. Claude read the results, and the lift held.
  3. Designer (Claude Cowork/Desktop + Snowflake MCP): built the campaign brief and positioning. An MCP check verified every stat, and Claude Design produced the launch assets. A CoWork agent monitors the launch with a daily digest.
- **Same agent, different model**: a lighter model joined on the wrong calendar and confidently reported a wrong answer. The frontier model checked its work against the ledger, recovered, and flagged a caveat. Use evals and effort sweeps to pick models.
- **Trust by design**: governed by default (row-level security), one identity and permission model, observable and auditable, and cyber defense at the model layer.
