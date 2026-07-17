# Architecture Decision Records

Decisions we don't relitigate. If you want to change one, open a new ADR that supersedes it — don't edit history.

## Template

```markdown
# ADR-NNNN: <Title>

- **Status:** accepted | superseded by ADR-XXXX
- **Date:** YYYY-MM-DD

## Context
<the problem and the forces at play>

## Decision
<what we chose>

## Consequences
<what this buys us, what it costs, what the escape hatch is>
```

## Index

- [ADR-0001 — Stack](ADR-0001-stack.md)
- [ADR-0002 — Record storage: JSONB](ADR-0002-record-storage-jsonb.md)
- [ADR-0003 — API conventions](ADR-0003-api-conventions.md)
- [ADR-0004 — No webhooks in v1](ADR-0004-no-webhooks-v1.md)
- [ADR-0005 — Record ordering: one fractional index per database](ADR-0005-record-ordering.md)
- [ADR-0006 — Spaces as the guest-scoping unit](ADR-0006-spaces.md)
- [ADR-0007 — Access grants](ADR-0007-access-grants.md)
- [ADR-0008 — Outgoing webhooks](ADR-0008-outgoing-webhooks.md)
- [ADR-0009 — The `contributor` rung](ADR-0009-contributor-rung.md)
- [ADR-0010 — The agentic execution engine](ADR-0010-agentic-os-engine.md)
- [ADR-0011 — Workflow state field: select + shared category layer](ADR-0011-workflow-state-field.md)
- [ADR-0012 — Converting a text/select field into a relation](ADR-0012-field-to-relation-conversion.md)
- [ADR-0013 — Migration framework + external-id primitive](ADR-0013-migration-framework.md)
