# the reference tool template library — full review (2026-07-10)

Founder directive: review the reference tool's template library, decide what StoryOS needs, and max out what
our machinery can already deliver. Source: the reference tool.com/templates + the 13 pages dug individually.
Verdicts: **BUILD** (new pack), **UPGRADE** (extend an existing pack), **ENABLER** (needs new
product functionality first), **SKIP** (not for JCM's move-in).

One meta-lesson from your current tools's library beats any single template: **every template ships with a
README that teaches the workflow** ("tips from fellow creators"), not just empty databases. Our
packs install silently. That's the first gap to close → guide docs shipped with every template
(MN-053), surfaced in the gallery and after install.

---

## 1. Meetings — BUILD (MN-054)

the reference tool: `Meeting ↔ Action Item`; "capture meeting notes (daily, project status), track action
items execution." We only have a Meetings database inside the Client Space pack. A standalone
pack is a daily-driver for any team: Meetings (type, date+time, attendees, rich-text notes) ↔
Action Items (task DNA lite, due, owner, done), calendar view on meetings, "My open action items"
view. Our rich_text + calendar + person fields cover 100% of it.

## 2. Content Marketing — UPGRADE content-pipeline (MN-055)

the reference tool: `Article ↔ Topic`, idea capture → rating → draft → publish, writer-workload views.
We have Articles + Campaigns. Missing: **Topics** database (SEO clusters), idea **Rating**
(number 1–5), **Word count**, writer-workload view ("by Author" board), "Ideas to rate" view.
All existing machinery.

## 3. Customer Journey Map — BUILD, simplified (MN-056)

the reference tool'ships NINE databases (Journey, Stage, Action, Emotion, Goal, Opportunity, Pain point,
Thought, Touch point) — faithful to CX theory, hostile to adoption. Ours: **Journeys ↔ Stages ↔
Insights** where Insight has `Kind` select (Goal / Action / Thought / Emotion 😊😐😣 / Pain point /
Opportunity) + Touchpoint text + Severity. Same analytical power, three databases instead of nine.
Board of Insights grouped by Kind per Stage replaces their map view.

## 4. Event Planning — BUILD (MN-057)

the reference tool: `Event, Expense, Task, Category`; "track budget, see which category is most expensive."
Ours: Events (date, venue, status, budget) ↔ Tasks (DNA-lite) ↔ Expenses (amount, category select,
paid checkbox). Budget-vs-actual *sum* needs **rollups** (MN-064) — until then the guide shows a
manual pattern; the pack still carries most of the value (checklists + expense log + calendar).

## 5. Digital Video Production — BUILD (MN-058)

the reference tool: `Video, Expense, Stage, Task` + script writing. Ours: Videos (Stage select
Idea→Script→Shoot→Edit→Published, publish date, platform, script as rich_text) ↔ Tasks ↔ Expenses.
Calendar on publish dates, board by Stage. JCM does video — high value, zero new machinery.

## 6. Content Calendar — UPGRADE social-calendar (MN-059)

the reference tool: `Calendar moment, Content, Platform` — the interesting idea is **Calendar Moments**
(holidays/launches/awareness days as first-class records the content attaches to). We already
added a calendar view to social-calendar (MN-051). Missing: Moments database (date, kind) related
to Posts, and Platforms as a database (with specs/links) instead of a bare multi-select.

## 7. Campaign Brief — BUILD merged (MN-060)
## 8. Product Marketing — merged into MN-060

Two the reference tool templates, ~70% overlapping (`Campaign, Content, Audience, Key metric / Channel,
Task`). One StoryOS pack: **Campaigns HQ** — Campaigns (objective rich_text, status, dates,
budget) ↔ Audiences ↔ Key Metrics (target vs actual numbers) ↔ existing Articles/Posts by name
(cross-pack relations, machinery exists). Covers brief-writing AND execution tracking.

## 9. Sales CRM — UPGRADE agency-crm (MN-061)

the reference tool: `Account, Opportunity, Sales task, Contact` — a real pipeline. Our agency-crm (Leads +
Proposals) is thinner than JCM needs. Upgrade to: Accounts ↔ Contacts ↔ Opportunities (stage
pipeline board, amount, close date, probability) ↔ Sales Tasks (next-step discipline). Pipeline
*value per stage* wants rollups (MN-064) but the board carries the workflow today.

## 10. Org Chart — BUILD pack now, hierarchy view later (MN-062)

the reference tool: `Team ↔ Employee` + manager self-relation + a dedicated **org-chart view** + employee map.
Databases and relations we can ship today (self-relations work — task DNA proves it). The
hierarchy visualization is a real view-type gap — noted inside MN-062 as a future view type, not
blocking the pack (Managers board + Teams table carry it).

## 11. Vacations Pro — BUILD simplified (MN-063), full version blocked on rollups

the reference tool's 8-database version (Country, Year, Allocation, Overtime, Public Holiday…) with computed
remaining-days and Slack commands is their "Advanced & Technical" showcase. The computation
`allocation − used + overtime` **requires rollups over relations** (MN-064) — formulas can't
aggregate. V1 pack: Team Members ↔ Time Off (kind: Vacation/Sick/Overtime, start, end, days
number, approved) + Public Holidays; calendar view of absences ("who's out"), "pending approval"
view. That's 80% of the daily value; balances land with MN-064.

## 12. GitHub — ENABLER + BUILD v1 (MN-065). *Founder: "you can do this significantly better."*

the reference tool: one-way sync of Repository/Branch/Issue/PR/Member; value = linking PRs to work items.
Where we can genuinely beat them: (a) our records already do task DNA, so imported issues land in
a working tracker, not a mirror; (b) **branch-name convention linking** — a branch `mn-123-fix`
auto-links the PR to record MN-123 (the reference tool makes you link manually); (c) self-hosted = your token
never leaves your box. V1: token-based import + refresh of Issues/PRs into a GitHub pack,
auto-linking by `#id` / branch-name mention. Webhooks + two-way sync = v2.

## 13. Linear — BUILD as importer (MN-066)

For the reference tool this is a sync integration (User/Issue/Document/Initiative/Project/Milestone/Team/
Cycle). For us it's funnier: our dev-project pack IS the Linear model (their template docs even
confirm the shapes we chose for task DNA). So the deliverable is a **Linear importer**: API-key
import of teams→spaces, projects, issues (states/priorities/labels/assignees mapped to our DNA),
cycles→Sprints. "Leave Linear, keep your data" is a sharper pitch than "mirror Linear."

## Cross-cutting gaps found

| Gap | Blocks | Ticket |
|---|---|---|
| Template guide docs (README with every pack, in gallery + post-install) | every template's teachability | MN-053 |
| Rollups (sum/count/avg over relations) | vacations balances, event budgets, pipeline totals | MN-064 |
| Hierarchy/org-chart view type | org chart visualization | noted in MN-062, future |
| Integrations framework (token store, sync jobs) | GitHub, Linear importers | MN-065/066 carry a minimal version |

Also ticketed from this session: **MN-067 branding** — logo, favicon, OG image, SEO meta (the
product currently ships a letter-"S" square and no social cards).
