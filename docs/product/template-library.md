# Template library plan

Templates are the onboarding (MN-033: nobody starts from blank). This is the catalog plan: what packs exist, what's in each, and who they're for. Rules that keep templates good:

- **3–4 databases per pack, max.** A template that models everything teaches nothing.
- **Every pack ships a board** — the aha-moment is dragging a card, not reading a table.
- **Every pack ships ≥1 relation** — relations are the product; a pack without one is a spreadsheet.
- **Sample data tells a story** (recognizable names, realistic states), and is removable in one click.
- Packs decompose: each database in a pack is also installable alone into any space (MN-033).

Categories: `agency` (step 1 — our own use cases), `creators` (step 2 — authors, experts, consultants, coaches), `dev` (step 3 — planned after founder feedback).

---

## Category: Agency (step 1)

The JCM suite — also the dogfood set. Four packs that compose into a full agency OS.

### 1. Client Work *(upgrade of the existing `client-work`)*

The default suggestion for agency signups. **Databases:**

| Database | Fields | Views |
|---|---|---|
| **Clients** | Status (Lead/Active/Paused/Churned), Owner (user), Website, Notes-in-description | All Clients (table), Active (filtered) |
| **Contacts** *(new)* | Client (→Clients, M:1), Role (text), Email, Phone (text) | All Contacts |
| **Projects** | Client (→Clients, M:1), Status (Planning/Active/On Hold/Done), Lead (user), Start/Due Date | Projects Board (by Status), All Projects |
| **Tasks** | Project (→Projects, M:1), State (Backlog/To Do/In Progress/Review/Done), Assignee, Priority, Due Date, Estimate h | **Task Board** (by State), My Tasks (Assignee = me), Due This Week |

Relations: Clients→Contacts, Clients→Projects, Projects→Tasks. Sample story: two clients, three projects, ~10 tasks across all states. *(Change vs today: adds Contacts, adds "My Tasks" view using the `me` filter.)*

### 2. Agency CRM

Pipeline before the client exists. **Databases:** **Leads** (Stage board: New/Contacted/Call Booked/Proposal/Won/Lost; Deal Value, Source select, Owner, Next Step Date, Email) + **Proposals** (Lead →M:1, Status, Value, Sent Date, Link). One-way door: a Won lead's record links onward when they become a Client (cross-pack relation created by the user — the sample data demonstrates it if Client Work is also installed).

### 3. Content Pipeline *(exists — joins this category)*

Articles (Stage board) ↔ Campaigns. Unchanged; gains the `agency` + `creators` category tags.

### 4. Social Media Calendar

**Posts** (Channel multi-select: LinkedIn/X/Instagram/YouTube; Status board: Idea/Drafted/Scheduled/Published; Publish Date, Copy in description, Link) with an optional relation to Articles when Content Pipeline is present. Views: Post Board, This Week (date filter).

---

## Category: Creators — authors, experts, consultants, coaches (step 2)

Solo or tiny-team practices. The common spine is *people I serve + things I deliver + sessions/appearances*, flavored per persona. Three packs, deliberately not one mega-pack:

### 5. Coaching Practice

| Database | Fields | Views |
|---|---|---|
| **Clients** | Status (Discovery/Active/Paused/Alumni), Program (→Programs, M:1), Email, Start Date, Goal (text) | Client Board (by Status), Active |
| **Programs** | Type (1:1 / Group / Course), Price (number, currency), Length (text), Active (checkbox) | All Programs |
| **Sessions** | Client (→Clients, M:1), Date (datetime), Status board (Scheduled/Done/No-show/Rescheduled), Notes in description | Session Board, Upcoming (Date within next_7_days) |
| **Action Items** | Client (→Clients, M:1), Session (→Sessions, M:1), Done (checkbox), Due Date | Open Items (Done = false) |

The pitch: your whole practice — who, what program, every session's notes, and what they promised to do — linked together. (Calendar view is v2; "Upcoming" filtered tables carry sessions until then.)

### 6. Consulting Engagements

| Database | Fields | Views |
|---|---|---|
| **Clients** | Status, Industry (select), Contact Email, Owner | All Clients |
| **Proposals** | Client (→Clients, M:1), Stage board (Draft/Sent/Negotiating/Won/Lost), Value (currency), Sent/Close Date | Pipeline Board (the money view) |
| **Engagements** | Client (→Clients, M:1), Proposal (→Proposals, M:1), Status (Active/Wrapping/Done), Start/End Date, Monthly Value | Engagement Board |
| **Deliverables** | Engagement (→Engagements, M:1), State board (Scoped/In Progress/Review/Delivered), Due Date, Owner | Delivery Board, Due This Week |

### 7. Author Studio

| Database | Fields | Views |
|---|---|---|
| **Books** | Status (Idea/Writing/Editing/Published), Genre (text), Target Word Count, Deadline, Publisher (text) | All Books |
| **Chapters** | Book (→Books, M:1), Status board (Outline/Draft/Revised/Final), Word Count, Order (number) | **Manuscript Board**, By Book (sorted) |
| **Research Notes** | Chapters (→Chapters, M:N), Source (url), Type (Interview/Article/Book/Idea), content in description | All Notes |
| **Launch Tasks** | Book (→Books, M:1), State board, Due Date, Channel (select: Podcast/Newsletter/Social/PR) | Launch Board |

Experts building an audience (courses, speaking, podcast circuits) are covered by **Content Pipeline + Social Calendar** plus one addition worth considering: an **Appearances** database (Pitched/Booked/Recorded/Aired board for podcasts & stages) — could join Author Studio or stand alone as a single-database template.

---

## Category: Dev teams (step 3 — TBD)

Deliberately not planned yet — awaiting founder feedback on steps 1–2 first. Sketch-level candidates: solo-dev product tracker (Features/Bugs board + Releases), lightweight sprint pack (Issues/Sprints/Releases with relation-driven scoping). To be shaped against what Linear/GitHub Projects *don't* cover: mixing dev work with the same workspace that runs content and clients.

## Implementation notes

- All packs are additions to `apps/api/src/templates/definitions.ts` — the installer (MN-032) already handles fields/options/relations/views/samples; only `category`/`scope` metadata and the preview payload are new (MN-033).
- "My Tasks"-style views need the `me` token in saved view filters — supported by the query engine already; the view validator must allow it.
- Currency formatting on Value/Price fields uses the existing number `format: currency` config.
