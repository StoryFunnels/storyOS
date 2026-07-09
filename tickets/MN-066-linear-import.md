---
id: MN-066
title: Linear importer — leave Linear, keep your data
status: todo
depends_on: []
size: M
---

Fibery's `linear` template mirrors Linear (8 synced databases). Our dev-project pack already IS the Linear model — so our play is migration, not mirroring.

## Design
- Settings → Integrations → Linear: API key; pick teams.
- Import via Linear GraphQL: team → a dev-project-shaped space (Issues with State/Priority/Labels/Assignee-name mapped to task DNA options, Estimate, parent/blocked relations where present), cycles → Sprints, projects → Projects db.
- One-shot import with dry-run summary (count per database) reusing the CSV-import UX pattern; person fields left unassigned with a note (users must exist first), assignee names preserved in a text field.
- Idempotency: `Linear ID` field, re-import updates.

## Acceptance criteria
- [ ] API-key import: teams → spaces, issues/cycles/projects mapped to dev-project shapes; dry-run first
- [ ] Idempotent re-import; names preserved when users absent
- [ ] Guide with mapping table (Linear field → StoryOS field)
