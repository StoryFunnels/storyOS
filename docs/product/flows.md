# Key flows

Step-by-step walkthroughs of the six flows that define v1 UX. Every step maps to public API calls.

## 1. Onboarding: create workspace → first database from template

1. Visit instance → sign up (email, password, name) → verify email.
2. "Create your workspace": name → template picker: **Client Projects & Tasks** / **Content Pipeline** / **Blank** (cards show which databases + relations each installs).
3. Pick *Client Projects & Tasks* → server installs the template via internal calls to the public API (space, 3 databases, fields, 2 relations, options, 6 views, ~10 sample records tagged as sample).
4. Land on the Tasks "Task Board" with a 4-step checklist overlay: *rename a sample client · drag a task card · invite a teammate · create your own database*. "Remove sample data" button in a banner.

## 2. Creating a database + fields + a relation

1. Sidebar → space "⋯" → **New database** → name "Posts", pick icon → created with title field + default table view.
2. Table header **+** → field type menu → *Select* → name "Status", add options (Idea / Drafted / Scheduled / Published) with colors → save. Repeat for a date field "Publish Date" (include time ✓).
3. **+** → *Relation* → picker: target database (searchable across spaces) = "Articles"; cardinality prompt in plain language: "Each Post relates to **one Article** / **many Articles**" → choose one (many-to-one) → inverse field name pre-filled on Articles as "Posts" (editable) → create.
4. Confirmation toast deep-links to Articles showing the new "Posts" collection field. Total: 4 API calls, all visible in `/api/docs`.

## 3. Building a kanban view

1. On Posts → view switcher → **+ New view** → type **Board**, name "Post Board".
2. Group-by picker lists eligible fields (single-selects) → choose Status → columns appear in option order + "No Status".
3. Toolbar → **Filter** → `Publish Date · within · next 30 days` → **Card fields** → show Publish Date, Channel.
4. Autosaved on each change (PATCH view). Dragging a card Drafted → Scheduled is one atomic `move` call (position + Status value); an activity event is recorded.

## 4. Inviting a member and a guest

1. Settings → Members → **Invite** → `max@jcm.agency`, role **Member** → email (or copyable link) → Max signs up via link → active immediately, sees everything.
2. **Invite** → `dana@client.com`, role **Guest** → space multi-select appears (required) → choose "Client Work" only → invite sent.
3. Dana logs in: sidebar shows only "Client Work"; write affordances hidden except commenting; API calls against other spaces return **404** (not 403 — don't leak existence).

## 5. Commenting & mentioning

1. Max opens a Task from the board (peek panel) → Comments tab → types "Blocked on assets — `@Olena` can you upload the logo pack?" — `@` opened the member picker.
2. POST comment → server extracts mentions from the body (never trusted from the client) → activity event + email to Olena with excerpt and deep link (if SMTP configured).
3. Olena clicks the link → entity page → drags `logo-pack.zip` onto the Attachments strip → replies. The Activity tab interleaves field changes, comments, and attachments chronologically.

## 6. API token + using the API

1. Settings → API → **New token** → name "slack-digest" → token shown once, copy.
2. Discover schema: `GET /api/v1/workspaces/:ws/databases` → find Tasks → `GET .../databases/:id` → fields incl. `state` options and `project` relation metadata.
3. Query:
   ```http
   POST /api/v1/workspaces/:ws/databases/:id/records/query
   {"filter": {"and": [{"field": "state", "op": "has_none", "value": ["opt_done"]}]},
    "sorts": [{"field": "due_date", "direction": "asc"}], "expand": ["project"]}
   ```
   → paginated records keyed by `api_name`, project expanded to `{id, name}`.
4. Update from the script: `PATCH /api/v1/.../records/:rid {"values": {"state": "opt_in_progress"}}` → same activity trail as UI, actor rendered as "slack-digest (Olena)".
5. `/api/docs` renders the full OpenAPI reference; an MCP server needs only steps 2–4.
