# Template library plan — v2

Templates ARE the onboarding (MN-033). v2 revisions from founder feedback (2026-07-08):

- **Generous fields.** Deleting a field is one click; discovering you need one is friction. Every database ships fuller than minimal. (Supersedes v1's lean-fields stance.)
- **Task DNA everywhere.** Every task-like database shares one Linear-informed recipe (below) so the same muscle memory works across packs — and it's already dev-team-grade.
- **Intent-based onboarding.** The gallery doesn't ask "pick a template," it asks **"what are you working on?"** Some intents are one-time setups (workspace packs); some are *recurring jobs* installed as spaces — above all **"onboarding a new client,"** which creates a client-shareable space (spaces are the guest-scoping unit, ADR-0006).

Rules that survive from v1: every pack ships a board + ≥1 relation; sample data tells a removable story; pack databases install standalone too.

---

## Task DNA (the shared task recipe, Linear-informed)

Source model: Linear issues — status categories with Triage as an inbox, priority incl. Urgent, flexible labels, estimates, sub-issues, blocking relations, cycles for rhythm.

**Fields (every task database):**

| Field | Type | Notes |
|---|---|---|
| State | select | **Triage** (gray) → Backlog (gray) → To Do (blue) → In Progress (gold) → In Review (purple) → Done (green) → **Canceled** (brown). Triage = the inbox: anything captured fast lands here and gets sorted later |
| Priority | select | Urgent (red) / High (orange) / Medium (blue) / Low (gray) — empty = no priority, and that's fine |
| **Labels** | multi_select | Starter tags per pack (see packs); users grow their own taxonomy |
| Assignee | user | |
| Due Date | date | |
| Estimate | number | points or hours — the label says "Estimate (pts)" |
| Effort spent | number | optional actuals; delete if unused |
| **Parent task** | self-relation (one_to_many) | sub-tasks — inverse "Sub-tasks" |
| **Blocked by** | self-relation (many_to_many) | inverse "Blocks" |
| + pack-specific relation(s) | relation | Project / Client / Article / Funnel / Sprint… |

**Views (every task database):** **Board** (by State), **Triage** (State = Triage — the grooming view), **My Tasks** (Assignee = me, not Done/Canceled), **Due This Week**, **All tasks** (table).

Cycles/sprints are a *database*, not a field — the Dev pack ships a Sprints database with a Task→Sprint relation; other packs skip it (agencies live by due dates, not cycles).

---

## Onboarding intents — "What are you working on?"

The first question in the gallery (and at workspace creation). Each answer maps to an install:

| Intent | Installs | Scope |
|---|---|---|
| **Running an agency** | Agency suite (Client Work + CRM; offers Content + Social next) | workspace |
| **Onboarding a new client** ⭐ | **Client Space** — a per-client space, ends with "invite {client} as guest" | space, *recurring* |
| **Starting a dev project** | Dev Project pack | space |
| **Launching a blog / content engine** | Content Pipeline + Social Calendar | space |
| **Writing a book** | Author Studio | space |
| **Running a coaching practice** | Coaching Practice | workspace |
| **Consulting / client engagements** | Consulting Engagements | workspace |
| **Something else** | full gallery + Blank | — |

⭐ **Client Space is the key insight:** it's not onboarding, it's a monthly ritual. "New client" → a space named after them with client-facing boards → invite their contact as a guest (read + comment, sees only this space). The template's last step IS the guest invite dialog.

---

## Category: Agency

### 1. Client Work *(workspace pack — the agency backbone)*

**Clients:** Status (Lead/Onboarding/Active/Paused/Churned) · Owner (user) · Industry (select: SaaS, E-commerce, Publishing, Coaching, Local, Other) · Company Size (select: Solo, 2–10, 11–50, 50+) · Website · Contact Email · Phone (text) · LinkedIn (url) · Monthly Value (number, currency) · Client Since (date) · **Health** (select: Great/OK/At risk/🔥) · Referral Source (text). Views: All Clients, Active (filtered), **Health Board** (by Health).

**Contacts:** Client (→Clients M:1) · Role (text) · Email · Phone (text) · LinkedIn (url) · Timezone (text) · Is Decision Maker (checkbox) · Birthday (date). Views: All Contacts, By Client (sorted).

**Projects:** Client (→Clients M:1) · Status (Scoping/Planning/Active/On Hold/Delivered/Closed) · Type (select: Retainer, One-off, Sprint, Maintenance) · Lead (user) · Team (user multi) · Priority · Start/Due Date · Budget (currency) · Billed (currency) · Brief-in-description. Views: **Projects Board** (by Status), Active by Due Date, By Client.

**Tasks:** full **Task DNA** + Project (→Projects M:1). Starter labels: `design` `copy` `dev` `ads` `email` `strategy` `admin` `client-waiting` `internal`.

**Invoices** *(MN-082 — closes the billing loop)*: Status (Draft/Sent/Paid/Overdue/Void) · Invoice # (text) · Amount (currency) · Issued/Due/Paid Date · Invoice Link (url) · Notes (text) · Client (→Clients M:1) · Project (→Projects M:1). Views: Invoice Board (by Status), Unpaid & Overdue, **Payment Calendar** (by Due Date), Recent Invoices (feed, by Issued Date).

Also new (MN-082): **Client Directory** (gallery, on Clients), **All Contacts** (list, on Contacts), **Project Timeline** (timeline, Start→Due, on Projects) — the same interlinked data, three more lenses on it.

### 2. Client Space ⭐ *(space template — recurring, client-shareable)*

Installed per client, named "{Client name}". Everything here is guest-visible by design.

**Tasks** (client-facing): Task DNA minus internal noise — State board (Triage hidden from the shared view), labels `for-client` `waiting-on-client` `in-house`, plus **Client Approval** (select: Not needed / Waiting / Approved / Changes requested). Views: **Shared Board** (the one the client watches), Waiting on Client (filter), Internal (label ≠ for-client).
**Deliverables:** Status (Draft/In Review/Approved/Delivered) · Type (select: Design, Document, Video, Campaign, Website, Report) · Due Date · Link (url) · Version (number) · Task (→Tasks M:N) · files as attachments. Views: Delivery Board, Approved.
**Meetings:** Date (datetime) · Type (select: Kickoff, Weekly, Review, Ad-hoc) · Attendees (user multi) · Recording (url) · agenda/notes in description · Action items → Tasks (M:N). Views: Upcoming, All notes.
**Requests** *(the client's inbox)*: guests can't create records (v1 role model), so this is where the team logs client asks from comments/email: Status (New/Accepted/Declined/Done) · Requested By (text) · Task (→Tasks M:1 once accepted). View: Request Board.

Install flow ends with: *"Invite {client contact} as a guest to this space →"*.

### 3. Agency CRM *(workspace pack)*

**Leads:** Stage board (New/Contacted/Call Booked/Proposal Sent/Negotiating/**Won**/**Lost**) · Deal Value (currency) · Probability (select: 10/25/50/75/90%) · Source (select: Referral, Inbound, Outbound, Event, Partner) · Owner · Company (text) · Contact Email · Phone · Website · Next Step (text) · Next Step Date · Lost Reason (select: Budget, Timing, Competitor, Ghosted, Bad fit). Views: **Pipeline Board**, This Month's Follow-ups, Won (for conversion ritual).
**Proposals:** Lead (→Leads M:1) · Status (Draft/Internal Review/Sent/Won/Lost) · Value (currency) · Sent/Valid-Until Date · Link (url) · scope in description. Views: Proposal Board, Open Proposals.

### 4. Content Pipeline *(space pack; also `creators`)*

**Articles:** Stage board (Idea/Brief/Writing/Editing/**Design**/Ready/Published) · Content Type (Blog post, Newsletter, Case study, Landing page, Video script, Podcast notes) · Author · Editor (user) · Target Publish Date · Published Date · Primary Keyword · Secondary Keywords (text) · Published URL · Word Count · **Labels** (`pillar` `seo` `launch` `evergreen` `client-work`) · CTA (text). Views: Editorial Board, Publish Schedule, By Author.
**Campaigns:** Status (Planned/Running/Done) · Goal (text) · Owner · Start/End Date · Budget (currency) · Channel (multi: Email, Social, Paid, Partner) · Articles (M:N). Views: Campaign Board, Calendar-order table.

### 5. Social Media Calendar *(space pack; also `creators`)*

**Posts:** Status board (Idea/Drafted/Approved/Scheduled/Published) · Channel (multi: LinkedIn, X, Instagram, YouTube, TikTok, Facebook) · Format (select: Text, Carousel, Image, Video, Story) · Publish Date (datetime) · Owner · Article (→Articles M:1 when Content pack present) · Hook (text) · Link (url) · copy in description. Views: Post Board, This Week, By Channel.

### 6. Funnels *(single-database template — JCM domain expertise; nobody else's gallery has this)*

**Funnels:** Status board (Idea/Building/Testing/**Live**/Paused/Archived) · Funnel Type (Webinar, VSL, Lead Magnet, Book Launch, Evergreen, Challenge) · Client (→Clients M:1 when Client Work present) · Owner · Launch Date · Funnel URL · Traffic Source (multi: Ads, Organic, Email, Partner) · Visitors /mo (number) · Opt-in % · Conversion % · Revenue /mo (currency) · offer notes in description. Views: Funnel Board, Live funnels (with the numbers), By Client.

---

## Category: Creators (authors, experts, consultants, coaches)

### 7. Coaching Practice *(workspace pack)*

**Clients:** Status board (Discovery/Proposal/**Active**/Paused/Alumni) · Program (→Programs M:1) · Email · Phone · Timezone (text) · Start Date · Renewal Date · Price Paid (currency) · Goal (text) · **Progress** (select: Just started/On track/Stuck/Breakthrough) · intake notes in description. Views: Client Board, Active, Renewals Coming (date filter).
**Programs:** Type (1:1, Group, Cohort, Course, Retreat) · Status (Active/Enrolling/Archived) · Price (currency) · Length (text) · Capacity (number) · Enrolled (number) · Curriculum-in-description. Views: All Programs.
**Sessions:** Client (→Clients M:1) · Program (→Programs M:1) · Date (datetime) · Status board (Scheduled/Done/No-show/Rescheduled/Canceled) · Type (select: Kickoff, Regular, Review, Emergency) · Recording (url) · notes in description. Views: **Session Board**, Upcoming (next_7_days), By Client.
**Action Items:** Task DNA (trimmed: no estimates) + Client (M:1) + Session (M:1) + Who (select: Client / Me). Views: Open Items, By Client, Waiting on Client.

### 8. Consulting Engagements *(workspace pack)*

**Clients:** as Client Work's Clients (same generous set) minus agency-isms.
**Proposals:** Stage board (Draft/Sent/Negotiating/**Won**/Lost) · Value (currency) · Type (select: Audit, Retainer, Project, Workshop) · Sent/Close Date · Win Probability (select) · Link · scope in description. Views: **Pipeline Board** (the money view), Open.
**Engagements:** Client (M:1) · Proposal (M:1) · Status board (Kickoff/Active/Wrapping/Done/Renewed) · Start/End Date · Monthly Value (currency) · Hours Budget / Hours Used (numbers) · Success Criteria (text). Views: Engagement Board, Ending Soon.
**Deliverables & Tasks:** full Task DNA + Engagement (M:1). Labels: `research` `workshop` `report` `analysis` `follow-up`.

### 9. Author Studio *(workspace pack)*

**Books:** Status board (Idea/Proposal/**Writing**/Editing/Production/Published) · Genre (text) · Target/Current Word Count (numbers) · Deadline · Publisher (text) · Agent (text) · ISBN (text) · Cover (attachment on record) · synopsis in description. Views: All Books.
**Chapters:** Book (M:1) · Status board (Outline/**Draft**/Revised/Final) · Order (number) · Word Count · POV/Theme (text) · Draft-in-description. Views: **Manuscript Board**, By Book in order.
**Research Notes:** Chapters (M:N) · Type (Interview, Article, Book, Idea, Quote) · Source (url) · Status (To read/Processed) · content in description. Views: All Notes, Unprocessed.
**Launch & Marketing:** full Task DNA + Book (M:1) + Channel (select: Podcast, Newsletter, Social, PR, Events, Ads). Views: Launch Board, By Channel.
**Appearances** *(also standalone template)*: Status board (Wishlist/**Pitched**/Booked/Recorded/Aired) · Type (Podcast, Stage, Webinar, Article/Guest post) · Show/Event (text) · Host Contact (text/email) · Date · Audience Size (number) · Link · Pitch-in-description. Views: Pitch Board, Upcoming, Aired (the brag sheet).

---

## Category: Dev teams (step 3 — Linear-informed, solo-dev first)

Positioning honesty: we won't out-Linear Linear for a 30-person eng org. The wedge is **the team whose dev work lives NEXT TO their content, clients, and funnels** — solo devs, indie hackers, agencies that also ship software (…JCM shipping StoryFunnels).

### 10. Dev Project *(space pack)*

**Issues:** full Task DNA with dev flavor — labels `bug` `feature` `chore` `docs` `design` `tech-debt` `good-first-issue`; Type (select: Bug/Feature/Improvement/Chore) · Sprint (→Sprints M:1) · Release (→Releases M:1) · Reproduction-in-description. Views: **Issue Board**, **Triage** (the inbox, front and center — Linear's best idea), Current Sprint, My Issues, Bugs only.
**Sprints:** Status (Planned/**Active**/Done) · Start/End Date · Goal (text) · Velocity note (number). Views: All Sprints. *(Lightweight cycles: one Active at a time by convention.)*
**Releases:** Version (title) · Status board (Planned/In Progress/Released) · Date · Changelog-in-description · Link. Views: Release Board, Shipped.
**Product Docs:** Type (Spec, Decision/ADR, Runbook, Idea) · Status (Draft/Agreed/Superseded) · Owner · Issues (M:N) · content in description. Views: All Docs, Open Specs.

### 11. Solo Dev *(space template — Dev Project minus ceremony)*

**Issues** (same DNA, no Sprint field) + **Releases**. Two databases, one Triage inbox, one board. For the indie hacker shipping on vibes and a changelog.

---

## Implementation notes

- Task DNA = a shared definition helper in `definitions.ts` so packs compose it rather than copy it (labels + extra relations parameterized).
- Self-relations (Parent/Blocked-by) and the `me` filter in saved views are already supported by the engine; the template installer needs self-relation support verified (MN-018 tested it) and the view validator must accept `"me"`.
- Cross-pack relations (Posts→Articles, Funnels→Clients): installer creates them **only when the target database exists** in the workspace; otherwise skips with a note in the install summary.
- Intent question = first screen of the MN-033 gallery; intents map to (template, scope) pairs; "New client" additionally pre-fills the space name and ends on the guest-invite dialog.
- Client Space's "Requests" database exists because guests can't create records in v1 — revisit if guest-created records ever land.

---

## Business Pack rebuild (MN-221 / #163)

#82 flagged these seven starters as too simple for real agentic work — schema and sample
records, no automation, no agent, nothing that runs. Once MN-218's pack manifest format
(`packages/schemas/src/packs.ts`) existed, each was rebuilt as a real Business Pack —
carrying the same databases, relations and sample data as the template above, plus what a
template cannot express: a workflow state with a **human gate**, a deterministic
**automation**, and an **agent** bound to that gated state transition. They live in the
Business Packs gallery (`GET /packs/registry`, `apps/web/.../w/[ws]/packs`) as the fuller,
agentic alternative to the plain templates above — see `apps/api/src/packs/starter-packs.ts`
for the manifests themselves.

Every agent below is deliberately gated (`human_gate: true`): each one drafts something
outward-facing or otherwise consequential, at exactly the transition where a person should
decide "run this now" rather than have it fire on every record silently.

| Starter (template) | Business Pack | Gated state → agent | Automation |
|---|---|---|---|
| Client Work | **Agency OS** (`agency-os`) | Client → *Onboarding* → **Onboarding Assistant** drafts a welcome packet | Notify on project status change |
| Client Space | **Client Portal** (`client-portal`) | Task's Client Approval → *Waiting* → **Approval Drafter** drafts the approval-request message | Notify on deliverable status change |
| Dev Project | **Dev Project OS** (`dev-project-os`) | Issue → *Triage* → **Triage Bot** proposes type/priority/labels | Notify when a release ships |
| Content Pipeline | **Content Engine** (`content-engine`) | Article → *Brief* → **Draft Assistant** writes a first outline | Notify when an article's stage changes |
| Author Studio | **Book Launch** (`book-launch`) | Chapter → *Draft* → **Revision Assistant** proposes revision notes | Notify when a chapter is finalized |
| Coaching Practice | **Coaching OS** (`coaching-os`) | Session → *Done* → **Session Notes Assistant** drafts notes + action items | Notify on client status change |
| Consulting | **Consulting OS** (`consulting-os`) | Proposal → *Negotiating* → **Follow-up Drafter** drafts the follow-up email | Notify on engagement status change |

Deliberately out of scope for the pack rebuild:

- **No cross-pack relations.** `ArchitectService.buildRelations` resolves a relation's `to`
  only against databases *the same manifest* declares, so a relation into another pack's
  database would 422 the moment that pack isn't already installed. Every Business Pack above
  is self-contained and installs standalone (unlike the cross-pack relations noted above for
  the plain templates, e.g. Funnels→Clients).
- **No sample-record cross-links.** `packSampleRecordSchema` carries `values` only (no
  `links`), so pack sample records are illustrative rows in various states, not a linked demo
  dataset the way template sample records are.
- **The intent-based onboarding flow (`INTENTS`, above) still installs the plain templates,
  not these packs.** Rewiring "what are you working on?" to install a Business Pack instead of
  a static template is a follow-up, not part of this rebuild — see the MN-221 PR description.
