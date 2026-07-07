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
