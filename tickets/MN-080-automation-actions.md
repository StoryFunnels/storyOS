---
id: MN-080
title: Automation actions — add more (Fibery-parity)
status: todo
depends_on: [MN-050]
size: M
---

Founder: more actions available; check what Fibery does. Today: set_values, create_record, add_comment.

## Fibery-inspired actions to add
- **Update linked/related record** (set fields on a related record).
- **Notify a user** (create a notification / @mention) — reuses the notifications system.
- **Add/remove a label (multi-select option)** convenience action.
- (Later: send email via SMTP, call webhook — ticket separately.)

## Design
- Extend the action schema (packages/schemas) + AutomationActionsService executor with the new action types, keeping {Field}/@me/@now interpolation.
- Builder UI gains the new action types with their param forms.

## Acceptance criteria
- [ ] At least two new action types (update-related, notify-user) execute in a rule and via a button
- [ ] Action schema validated; executor covered by a test
- [ ] Builder UI supports the new actions; verified in browser
