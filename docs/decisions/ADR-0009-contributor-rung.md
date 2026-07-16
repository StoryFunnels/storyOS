# ADR-0009: The `contributor` rung, and the ladder as the billing boundary

- **Status:** accepted
- **Date:** 2026-07-16
- **Supersedes:** [ADR-0007](ADR-0007-access-grants.md) — only the ladder itself; ADR-0007's scoping model, resolution rules and 404-not-403 convention stand unchanged.
- **Source:** founder decisions recorded on MN-121 (epic: Permissions & Access 2026-07).

## Context

ADR-0007 gave us `viewer < commenter < editor < creator`. It missed a case that turned up with the first real external team: read + **create**, without **delete**.

The reason it was impossible is that every delete required exactly the same rank as the corresponding update — records delete = editor, same as update; views delete = editor, same as create; fields delete = creator, same as create. Delete was welded to edit at every level, so the only choices were read-only or full destructive power.

Separately, the billing layer needed a predicate for "can this person create anything", to honour the public promise that viewers and guests are always free.

## Decision

**One rung, in the existing ladder** — not a new mechanism, not a capability matrix:

```
viewer < commenter < contributor < editor < creator   (< admin, workspace-wide)
```

| rung | adds |
|---|---|
| `contributor` | create + update records | **no delete**, no schema, no views |
| `editor` | + delete records, views, links, buttons |
| `creator` | + schema: fields, automations, rename |

**The ladder IS the billing boundary.** No second concept: billable = workspace `admin`/`member`, or any grant `>= contributor` on any scope. `viewer`/`commenter` are never billable. That makes "viewers and guests are always free" and "anyone who can create is a seat" the same sentence.

**Recorded with it:**
- **Members stay workspace-wide creators.** No member scoping. This is why MN-124 ("any member can delete any space") is not about restricting members — it is about making the graded ladder authoritative instead of a blunt `@MinRole('member')`.
- **No `owner` role.** Admin is the top rung and is enough.

## Consequences

- Space grants already cascade to contained databases, so the driving case is: invite the team as guests, grant `contributor` on the spaces, done.
- Delete is soft (records restore exists), so this rung is about intent and guardrails more than irreversible loss.
- Any new mutating route must now pick a rung deliberately: creating is `contributor`, destroying is `editor`. The two are no longer the same answer.
