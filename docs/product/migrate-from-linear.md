# Migrate from Linear

StoryOS imports your Linear workspace in one shot via the Linear GraphQL API — no CSV
gymnastics, no webhooks. Each team becomes a space shaped like our **Dev Project** pack.
The import is idempotent: every record carries its Linear ID, so re-running updates
records in place instead of duplicating them.

## How to run it

1. In Linear: **Settings → Security & access → API keys** → create a personal API key.
2. In StoryOS: **Settings → Integrations → Linear** (admin only) — paste the key,
   optionally list team keys (`ENG, OPS`) to import a subset. Empty = all teams.
3. Hit **Preview import** — you get counts per team (issues / sprints / projects)
   and nothing is written.
4. Hit **Import**. Done. Re-run any time to pick up changes made in Linear since.

## What maps to what

| Linear | StoryOS |
|---|---|
| Team | Space `"<Team name> (Linear)"` with Issues + Sprints + Projects databases |
| Issue | Record in **Issues** |
| Issue title / identifier / URL | Name / Identifier / URL |
| Workflow state (by *type*) | State select: triage → Triage, backlog → Backlog, unstarted → To Do, started → In Progress, completed → Done, canceled → Canceled |
| Priority (1–4) | Priority select: Urgent / High / Medium / Low (no priority → empty) |
| Labels | Comma-separated text (promote to multi-select later if you like) |
| Estimate | Estimate (number) |
| Assignee | **Assignee (name)** — plain text. Users aren't matched automatically: invite your team first, then reassign. Nothing is lost. |
| Parent / sub-issues | Parent Issue self-relation (Sub-issues on the other side) |
| Cycle | Record in **Sprints** (number, start/end dates) + Sprint relation on the issue |
| Project | Record in **Projects** (state, target date, URL) + Project relation on the issue |
| Issue ID (internal) | Linear ID text field — the idempotency key; don't edit it |

## What is intentionally NOT imported

- **Comments and issue descriptions** — v1 imports the tracker structure; bring
  narrative content over as you touch each issue.
- **Custom workflow state names** — we map by state *type* (Linear's own semantic
  layer), so "Ready for QA" (type: started) lands In Progress. Add an In Review
  pass manually where it matters; the State select already ships the option.
- **Members** — deliberate. Assignee names are preserved as text so nothing
  silently maps to the wrong account.

## Limits

- First 250 issues, 50 cycles and 50 projects per team per run. Re-running after
  archiving old issues in Linear is the workaround for bigger teams until
  pagination lands.
