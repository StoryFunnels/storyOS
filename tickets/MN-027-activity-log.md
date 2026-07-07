---
id: MN-027
title: Activity log
status: done
depends_on: [MN-025]
size: M
---

Surface the `activity_events` rows the mutation services have been writing since MN-011: ensure coverage (record created/updated/restored, relation linked/unlinked, comment created, document edited, attachment added), field-level diffs `{field_id: {from, to}}`, `GET /records/:id/activity` (cursor), and the Activity tab on the entity page rendering human-readable entries ("Olena changed State: To Do → Done") with option labels and record chips resolved at render time. Events are append-only, written in the mutation's transaction, never client-writable ([ADR-0004](../docs/decisions/ADR-0004-no-webhooks-v1.md) — this is the future webhook outbox, so type names are contract-grade).

## Acceptance criteria

- [ ] Every mutation type above produces exactly one event with the right payload (integration matrix test)
- [ ] Diffs render with display names; deleted fields render as "(deleted field)" without erroring
- [ ] PAT-driven changes render as "token-name (owner)"
- [ ] Cursor pagination on the feed; newest first
- [ ] Attempting to POST an activity event via API → 404/405 (no route exists)
