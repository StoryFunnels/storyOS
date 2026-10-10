---
title: Validation rules
description: Rules that refuse a record write when the data it would leave behind is not valid. They apply to everyone, with no bypass, and fire only when a field they reference changes.
sidebar:
  order: 20
---

A **validation rule** blocks a change *before* it happens. It is the opposite of an
[automation](/concepts/automations/), which reacts after the fact: when a rule fails, the write did
not happen, nothing is stored, and no automation fires for it.

"Done needs a summary", "every task needs a deadline", "if it is Blocked, say why" are all rules.

## What a rule is

A rule belongs to one database and has:

- **A trigger.** `create` (checked whenever a record is created), `update` (checked when an update
  changes a field the rule references), or `transition` (checked when a status field changes **to** one
  option, or a record is created already holding it).
- **A condition**, the thing that must be **true** of the record after the write. It is the same
  filter language saved views use, so it can reference several fields at once (a cross-field rule) and
  relations.
- **A message**, shown to whoever's write was refused.

A condition may reference stored fields and relations. It cannot reference a **formula, rollup,
lookup, AI or attachment** field: those are derived after the write commits, so there is nothing to
check yet. Declaring one is refused with a message saying so.

## Who it applies to: everyone

A rule applies to **every** write: a person in the web app, an admin, an API token, an MCP client, an
AI agent, an automation, a form submission, a CSV import, and restoring an old version of a record.
There is **no bypass**.

That is deliberate and differs from an [approval gate](/concepts/approval-gates/). A gate is about
*authority* (who may do this), so a role can be exempt. A rule is about *validity* (is this data
coherent), and the data does not know who wrote it. If a rule is wrong, an admin changes the rule, which
is visible and recorded; a silent bypass would turn the rule into a suggestion.

A refused write returns `422` with the rule's own message, and a refused batch reports which records
failed and why.

## It fires only when a field it references changes

A rule fires when **a field it references changed**, not on every update. This matters for existing
data: add "end date after start date" to a database full of imported rows and every non-conforming row
stays editable; you can still fix a typo in the name. A rule that reads field A to validate field B fires
when *either* moves. A `transition` rule fires only when its status field moves to the target.

## Existing violations stay visible

Because a rule only fires on a change, a record that is already invalid is not blocked and is not
caught. So every rule reports **how many stored records break it right now**, and which ones:

- the rule list carries a `violation_count` for each rule;
- `GET .../validation-rules/{id}/violations` returns a page of the records (id, number, title) that
  currently fail it. A `transition` rule only judges records currently at its target status.

Fixing one is an ordinary update. A rule that names a field you later deleted is **dangling**: it is
skipped on every write (it never locks the database) and is flagged in the list until you fix or delete it.

## A rule never silently stops enforcing

A rule stores a field's `api_name` and a transition's option **ID**, so renaming a field or an option changes
nothing about it and it keeps enforcing; a select-to-workflow conversion keeps it working too. What can stop
a rule enforcing is a change that removes what it reads, so those changes are **refused**:

- changing a field's type, when that would leave an enabled rule unable to check it (a transition rule needs a
  select or workflow field; a condition's operators must still fit the new type);
- deleting an option an enabled rule names, even if no record uses it.

The refusal names the rules. The change-type preview (`dry_run`) already lists `dependent_rules` and which of
them would break. To go ahead anyway, pass `confirm_dependent_rules: true` (the same refuse-unless-confirmed
pattern deleting an option that records still use already follows). After a confirmed change the rule is
marked **not checkable**: its `status` reads `not_checkable` with the reason, it is skipped on writes so it
never locks the database, its violation count is absent rather than a misleading 0, the violations list says
why it cannot answer, and it cannot be re-enabled until fixed. A rule is `enforcing`, `disabled` or
`not_checkable`, never enabled while enforcing nothing. Confirming is not available over MCP.

## Declaring them

Admin only, over the API: `POST /api/v1/workspaces/{ws}/databases/{db}/validation-rules` with
`{ name, trigger, transition?, condition, message }`; `PATCH` to change the name, condition, message or
enabled flag (the trigger is fixed; delete and redeclare to change it); `DELETE` to remove. There is no
settings page for this yet. MCP can **read** rules and violations (`list_validation_rules`,
`get_validation_rule_violations`) but not change them: an AI that could edit the rule constraining it
would defeat it.
