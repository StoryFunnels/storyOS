# Vision

**One-liner:** an open-source, self-hostable work platform where teams model their company as related databases — and run everything (client work, content, CRM, planning) on that one engine.

**Reference UX:** Fibery (databases + relations + views + entity pages), *not* Notion (docs-first). Rich text lives inside records; it is never the organizing skeleton.

**License & promise:** AGPL-3.0. The core is fully capable and free forever. Monetization (later) is managed cloud hosting and advanced AI features layered on top — never removing capability from the open core. If the community builds an MCP server or integrations on our API, that's success, not leakage.

## Product principles

1. **Relations are the core primitive.** Every design decision — schema builder, entity page, API shape — must make connecting databases the easiest, most obvious action. The relation picker is first-class UI, not a field-type footnote.
2. **API-first, no exceptions.** Every mutation the UI performs goes through the same public, documented, versioned REST API. The OpenAPI spec is always accurate because it *is* the API the UI calls.
3. **Capability is never paywalled in the core.** Future cloud-only extras must be additive, not subtractive.
4. **Structure over documents.** The unit of work is a record in a user-defined database, not a page in a tree.
5. **Schema is data.** Databases, fields, relations, and views are API resources with stable IDs. Changing schema is a runtime API call, not a migration. This makes templates, MCP servers, and AI features trivial later.
6. **Boring, predictable, self-hostable.** One Postgres, one server process, one Docker Compose file. No exotic infra (no Kafka, no CRDT service) in v1.
7. **Small surface, deep quality.** Everything on the "not in v1" list stays out, even when tempting.

## Personas

**P1 — Olena, the Builder (workspace admin).** Agency operations lead / founder, coming from Fibery or Notion. Designs the schema: databases, fields, relations, views, templates. Invites people, manages roles, creates API tokens. Success = *"I modeled our whole agency in an afternoon and stopped paying for Fibery."*

**P2 — Max, the Team Member.** Writer / PM / designer. Never touches schema. Lives in saved views: drags cards on the task board, updates fields, writes descriptions, comments and @mentions. Success = *"I open 'My Tasks', see what's next, and everything I need is one click deep."*

**P3 — Dana, the Client Guest.** The client's contact person. Read + comment, scoped to her client's space only. Checks project status and drafts; must never see other clients. Success = *"I stopped emailing 'what's the status?' — I just look at the board."*

## First user

JCM (agency). Day-1 workloads: client/project/task tracking and a content/article pipeline. The v1 acceptance bar is: **JCM runs its client work in this tool instead of Fibery.**

## Monetization stance (for later, recorded now)

- Self-hosted: everything, free, forever.
- Paid (future): managed cloud (backups, upgrades, SSO handled), hosted MCP endpoint with auth in two clicks, AI features (schema copilot, auto-summaries, agents operating the workspace) that carry real inference costs.
- We may later add cloud-only *conveniences* (e.g. some advanced views or advanced role tooling), but the self-hosted core must always be sufficient to run a real company.
