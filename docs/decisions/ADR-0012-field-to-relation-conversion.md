# ADR-0012: Converting a text/select field into a relation — a guided, dry-run migration

- **Status:** accepted (design; implementation is a follow-up)
- **Date:** 2026-07-17
- **Source:** #87 (MN — "Change field type → relation"). The ticket requires a written design before implementation; this is it.

## Context

`change_field_type` handles most conversions as value casts. It **cannot**
convert a field into a `relation`, yet that is a common real need: a text or
select column already holds the *names* of things that are actually records in
another database (imported data, hand-typed references), and the user wants a
genuine relation.

This is not a cast. A relation, in our model (ADR-0002, the relations design),
is a **schema + data migration**:

- it creates a **paired inverse field** on the target database, and
- it writes rows into the `record_links` join table.

And every existing cell must **resolve to a target record**, which introduces
matching, ambiguity, cardinality, and unmatched-value questions a silent cast
can't answer. So the conversion must be **guided and previewable**, never
automatic.

## Decision

Model it as a **guided conversion with a mandatory dry run**, reusing the
existing change-type `dry_run` machinery. Five steps:

1. **Pick the target database.** The database whose records the values name.
2. **Pick the match field.** Which field on the target to match values against —
   default **title**, or any unique-ish text/select field, or the record **id**.
3. **Dry-run preview (changes nothing).** Resolve every source cell and report
   **matched / ambiguous / unmatched** counts, with a sample of each bucket.
4. **Choose the unmatched policy** (see below).
5. **Apply.** Create the paired field + links; handle unmatched per policy;
   the original field is retained or removed per an explicit flag.

### Matching

- **Matched:** exactly one target record matches the cell on the match field.
- **Ambiguous:** two or more targets match (e.g. two records both titled
  "Acme"). Ambiguous values are **never auto-linked** — they fall to the
  unmatched policy, and the preview lists them so the user can disambiguate the
  target data first and re-run.
- Matching is case-insensitive and trimmed, mirroring the auto-link and
  duplicate-name conventions already in the codebase.

### Cardinality (inferred, confirmable)

- A **single scalar** value (text, single-select) → **`one_to_many`** by default
  (each source record points at one target).
- A **multi-select** or a delimited list (comma/newline) → **`many_to_many`**,
  splitting the cell into multiple links.
- The inferred cardinality is shown in the preview and can be overridden before
  apply.

### Unmatched policy (explicit, never silent)

The user picks one; the default is the safest, **Park**:

- **Park (default):** keep the original values in a retained text column
  (`<name> (unmatched)`), so nothing is lost and the user can fix them later.
- **Blank:** leave unmatched cells empty (original field removed).
- **Create:** create a new target record per distinct unmatched value and link
  it (guarded by a max-count so a typo-ridden column can't spawn thousands).

Unmatched values are **never silently dropped** — that is the one hard rule.

### Reversibility

`relation → text` is easy and lossy (write back the linked titles); `text →
relation` is the hard direction this ADR covers. Because Park retains the
originals and record deletes are soft (ADR-0009), a mistaken apply is
recoverable: unlink, restore the parked column.

## Consequences

- **Reuses what exists:** the `dry_run` contract, the relations/paired-field
  creation path, and the link table — no new subsystems, just an orchestration
  that composes them behind a preview.
- **The dry run is the safety mechanism.** Nothing schema- or data-changing
  happens until the user has seen matched/ambiguous/unmatched counts and chosen a
  policy. This is the same "propose as data, apply on confirm" discipline as the
  agent approval gates (ADR-0010).
- **Cost:** the matching + preview + multi-cardinality apply is real work; it
  ships as its own follow-up feature ticket (API: extend the change-type
  endpoint with a `to relation` mode carrying target db, match field, cardinality,
  unmatched policy; UI: a guided dialog surfacing the dry-run buckets). This ADR
  fixes the design so that work isn't relitigated mid-build.
- **Rejected — a silent cast** (match by title, drop the rest): loses data,
  can't express ambiguity or cardinality, and violates "never silently dropped."
