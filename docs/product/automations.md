# Automations

Rules that run actions when records change or on a schedule. Open them from a database's
`⋯` menu → **Buttons & automations**.

## Anatomy of a rule

**When** (trigger) → **Only if** (condition) → **Then** (actions)

- Triggers: *record created* · *record changes* (optionally scoped to one field — "when State
  changes") · *schedule* (hourly / daily / weekly at HH:mm, server time).
- Condition: any filter the views support; for scheduled rules the condition **is the selection** —
  the rule runs over every matching record.
- Actions (shared with Buttons): *set fields on this record* · *create a record* (optionally linked
  back through a relation) · *add a comment*. Tokens: `@me` (rule creator), `@today`, `@now`;
  `{Field Name}` interpolates values in comment and title templates.

## Recipes

| Goal | Rule |
|---|---|
| Escalate urgent tickets | When **State** changes · only if State is *Urgent* · add comment "⚠️ {Title} needs eyes" |
| Auto-stamp start dates | When **State** changes · only if State is *In Progress* · set *Started* = `@today` |
| Close stale Done work | Every day at 03:00 · only if State is *Done* · set *Archived* ✓ |
| Kickoff checklist on new client | When a record is created (Clients) · create a record in Tasks "Kickoff {Title}" linked back |
| Weekly digest ping | Every week at 09:00 · only if *Owner* is set · comment "Weekly review time" |
| Auto-assign triage | When a record is created · set *Assignee* = `@me` |

## Semantics worth knowing

- **Attribution**: runs act as the rule's creator; activity shows their name on the changes.
- **Loop guard**: an automation's own writes can trigger other rules **at most one more hop**
  (depth 2). Deeper cascades are skipped and logged — a rule can never ping-pong forever.
- **Auto-disable**: 10 consecutive failures switch a rule off (banner in the panel); editing the
  actions or re-enabling resets the streak.
- **Run log**: every execution (ok / error / skipped / skipped_quota) with duration is kept for 90 days (MN-264), and queryable across the whole workspace at `/w/:ws/runs` (or `GET /workspaces/:ws/runs`) alongside quota status.
- **Dry run**: `POST …/automations/:id/test { record_id }` answers "would this run?" without writing.
- **CSV imports do not fire automations** (mass-import safety, same choice as Airtable).
- Scheduled rules process up to 500 matching records per tick and note truncation in the server log.

## More actions (MN-080)

- **Update linked records** — set fields on every record linked through a chosen relation (e.g. when a Project is marked Done, set all its Tasks to Archived).
- **Notify a person** — send an in-app notification to a person field's value (or @me), with `{Field}` interpolation in the message.

All actions still support the `@me` / `@now` / `@today` tokens and `{Field Name}` interpolation, and run through the same executor for buttons and rules.
