# Use cases

Five concrete walkthroughs that v1 must support. UC1 and UC2 are the JCM day-1 workloads; UC3–UC5 prove generality.

## UC1 — Client / project / task tracking (JCM)

Olena installs the **Client Projects & Tasks** template → three related databases (Clients → Projects → Tasks) in a "Client Work" space. She adds JCM as a Client record, creates the "Q3 Website Refresh" Project linked to JCM, and 12 Tasks linked to the project.

Max works the "Task Board" kanban (grouped by State), dragging cards Backlog → In Progress → Done; each drag is one API call updating the State field and position. From a Task's entity page he opens the related Project, then the related Client — two hops through relations.

Dana (guest scoped to the "Client Work" space) uses the saved view "JCM Projects" (filter `Client = JCM`) to check status weekly, and comments on records when she has feedback.

## UC2 — Article / content pipeline

Olena installs **Content Pipeline**: an Articles database with a Stage select (Idea → Brief → Writing → Editing → Ready → Published), Author/Editor user fields, and a many-to-many relation to Campaigns.

The team runs the "Editorial Board" kanban grouped by Stage. Each Article entity page holds the brief in the rich-text description; the editor leaves comments with @mentions ("@Max intro needs a hook"), which email Max. When published, the URL field is filled and the card is dragged to Published. The "Publish Schedule" table view sorts by Target Publish Date.

## UC3 — Social media calendar (hand-built — proves generality)

Olena creates a new database *Posts* in the Content space: Channel (multi-select: LinkedIn, X, Instagram), Status (select: Idea/Drafted/Scheduled/Published), Publish Date (date+time), copy in the description, and a relation *Posts → Article* pointing at the existing Articles database (cross-database, even cross-space). Views: "Post Board" by Status; "This Week" table filtered `Publish Date within next 7 days`, sorted by date. No template needed — 10 minutes of schema building.

## UC4 — Lightweight CRM

A *Leads* database: Company (text), Contact Email (email), Website (url), Deal Size (number), Stage (select: New/Contacted/Proposal/Won/Lost), Owner (user), Next Step Date. A relation *Lead → Client* lets a Won lead link to the Client record it becomes. "Pipeline" board grouped by Stage; "My Leads" table filtered `Owner = me`. No formulas needed for v1 value.

## UC5 — Machine access / MCP

Olena creates an API token and gives it to a script that pulls all Tasks where `State != Done` and posts a Slack digest. Later, a community MCP server wraps the same API: because schema is introspectable (`GET /databases`, `GET /databases/:id` with fields + relation metadata), the MCP server exposes "query any database" tools with zero product changes. See [../api/README.md](../api/README.md).
