# ADR-0006: Spaces as the grouping and guest-scoping unit

- **Status:** accepted
- **Date:** 2026-07-07

## Context

Two forces: (1) sidebars with 15+ databases need grouping; (2) agencies must show clients their work and *only* their work. Per-database ACLs are v2-level complexity; workspace-wide guest access is useless for multi-client agencies.

## Decision

Introduce **Space**: a named group of databases (`spaces` table; `databases.space_id` required; a "General" space auto-created). Spaces are:

- the sidebar organizing unit,
- the unit templates install into,
- **the guest-scoping unit**: guest memberships carry `space_ids`; everything outside returns 404 (not 403 — don't leak existence).

Guest = read + comment within their spaces. Cross-space relation chips on visible records render name-only and non-navigable (small, accepted metadata leak in exchange for coherent UX; revisit on customer objection). Relations across spaces are fully allowed for members/admins.

## Consequences

- Near-zero engine cost (it's a folder with meaning) but it unlocks the JCM client-portal story in v1 without a permissions subsystem.
- Fine-grained permissions (per-database, per-field, custom roles) remain v2; when they arrive, spaces stay as the coarse default layer.
- Template design convention: one template = one space.
