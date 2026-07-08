---
id: MN-035
title: Agency template packs + Task DNA installer
status: done
depends_on: [MN-033, MN-034]
size: L
---

Implements the agency category of [docs/product/template-library.md](../docs/product/template-library.md): Task DNA as a composable definition helper (Triage/Canceled states, labels, sub-task + blocked-by self-relations, My Tasks/Triage/Due This Week views), then Client Work v2 (Clients/Contacts/Projects/Tasks with the generous field sets), **Client Space** (space-scoped, recurring, ends on the invite dialog with an `editor` grant preselected), Agency CRM, Social Calendar, Funnels; Content Pipeline upgraded in place.

## Acceptance criteria

- [ ] Task DNA helper composes into any pack (parameterized labels + extra relations); installs self-relations and 'me' views correctly
- [ ] All six agency templates install per the library doc (fields, options with colors, relations, views, sample stories)
- [ ] Client Space install pre-names the space, finishes on the guest-invite dialog with an editor grant on that space preselected
- [ ] Cross-pack relations (Funnels→Clients, Posts→Articles) created only when the target database exists; skipped with a note otherwise
- [ ] Integration test per pack: install → introspect matches the doc → samples removable
