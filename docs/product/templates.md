# Starter templates

Templates are JSON definitions installed via ordinary public-API calls (space → databases → fields → relations → options → views → sample records). Sample records are tagged and bulk-removable. Machine-readable definitions will live in the codebase; this file is the product spec for them.

## T1 — Client Projects & Tasks (space: "Client Work")

**Clients**
- Name (title) · Status (select: Active ●green, Paused ●yellow, Churned ●gray) · Owner (user) · Website (url) · Contact Email (email)
- Relation: **Clients ↔ Projects**, one-to-many (a Client has many Projects)

**Projects**
- Name · Client (relation → Clients, many-to-one) · Status (select: Planning, Active, On Hold, Done) · Lead (user) · Start Date (date) · Due Date (date)
- Relation: **Projects ↔ Tasks**, one-to-many

**Tasks**
- Name · Project (relation → Projects, many-to-one) · State (select: Backlog, To Do, In Progress, Review, Done) · Assignee (user) · Priority (select: Low, Medium, High, Urgent) · Due Date (date) · Estimate h (number)

**Views**
- Clients: "All Clients" (table)
- Projects: "Projects Board" (board by Status) · "All Projects" (table, sorted Due Date ↑)
- Tasks: "Task Board" (board by State; cards show Assignee, Priority, Due) · "All Tasks" (table) · "Due This Week" (table, filter `Due Date within next 7 days`, sort Due ↑)

**Sample data:** 2 clients (incl. "JCM"), 3 projects, 10 tasks spread across states.

## T2 — Content Pipeline (space: "Content")

**Articles**
- Name (working title) · Stage (select: Idea, Brief, Writing, Editing, Ready, Published) · Content Type (select: Blog post, Case study, Landing page, Newsletter) · Author (user) · Editor (user) · Target Publish Date (date) · Primary Keyword (text) · Published URL (url) · Word Count (number)
- Relation: **Articles ↔ Campaigns**, many-to-many

**Campaigns**
- Name · Status (select: Planned, Running, Done) · Start Date (date) · End Date (date) · Owner (user)

**Views**
- Articles: "Editorial Board" (board by Stage; cards show Author, Target Date, Content Type) · "Publish Schedule" (table, filter `Stage is any of Ready/Published`, sort Target Publish Date ↑) · "All Articles" (table)
- Campaigns: "Campaigns" (table)

**Sample data:** 6 articles across stages, 2 campaigns with links.

> A Social Posts database is deliberately **not** in this template — [UC3](use-cases.md) shows it's a 10-minute manual build; docs will include a "build a social calendar" tutorial instead.

## T3 — Blank

Default "General" space, no databases. Empty state renders the guided checklist (story F2) with "Create your first database" as the primary CTA.
