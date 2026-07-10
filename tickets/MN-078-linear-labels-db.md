---
id: MN-078
title: Linear importer — labels/tags as a Labels database + relation (not text)
status: done
depends_on: [MN-066]
size: M
---

Founder: labels/tags should be a database we reuse, not a comma-separated text field. Investigate what else Linear's API exposes and import the high-value entities as first-class databases.

## Investigate (Linear GraphQL)
Available on the API: teams, issues, projects, cycles, workflow states, **issueLabels**, users/members, milestones, comments, attachments. We currently import: teams→space, issues, cycles→sprints, projects; labels as comma text; assignee as text.
NOTE: Linear MCP needs OAuth (unavailable in this non-interactive session) — verify the live SF import via our own API/DB instead, and cross-check against Linear's documented GraphQL schema.

## Design
- New **Labels** database per imported team (name, color). Import `team.labels` (issueLabels).
- Issues gain a many-to-many **Labels** relation instead of the comma text field (keep the text as a fallback for un-mapped labels).
- Consider **Workflow States** and **Members** as future databases (ticket separately if valuable); labels first.
- Idempotent by Linear label id.

## Acceptance criteria
- [x] A Labels database is created and populated from Linear; issues link to labels via a relation
- [x] Re-import is idempotent; colors preserved
- [x] migrate-from-linear.md mapping table updated
