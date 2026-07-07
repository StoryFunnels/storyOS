---
id: MN-002
title: Docs skeleton in-repo + founding ADRs
status: done
depends_on: [MN-001]
size: S
---

The planning docs already exist in `docs/` (product, architecture, decisions, api) and `tickets/`. This ticket wires them into the development workflow: CONTRIBUTING.md pointing agents/contributors at docs first, doc-link checking, and any gaps found while scaffolding MN-001 folded back into the ADRs.

## Acceptance criteria

- [ ] `CONTRIBUTING.md` exists: how to pick a ticket, doc map, PR conventions (reference MN-### ids), "read the ADRs before proposing architecture changes"
- [ ] ADR index ([docs/decisions/README.md](../docs/decisions/README.md)) is accurate; any decisions changed during scaffolding get a superseding ADR, not an edit
- [ ] A markdown link checker runs locally (`pnpm docs:check`) and finds no broken intra-repo links
- [ ] tickets/README.md status column reflects reality (MN-001 flipped to done in its PR)
