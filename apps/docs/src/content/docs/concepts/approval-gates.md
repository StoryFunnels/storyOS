---
title: Approval gates
description: How StoryOS holds an AI's or an automation's action for a person's decision — three layers, one Inbox, and what a workspace admin can declare.
sidebar:
  order: 19
---

An **approval gate** stops an action until a person decides. It is enforced by the platform, not by
asking the AI nicely: an agent that ignores its instructions still cannot get past it.

## Three layers, one place to decide

1. **A rule's own approval flag.** An [automation](/concepts/automations/) action (an email, an
   outbound API call) can require approval, and some default to it.
2. **An agent's approval policy.** The owner of an [agent](/concepts/agent-runs/) can have its
   proposed writes wait for approval. This is a setting on that one agent — an owner who forgets to
   set it gets no gate.
3. **A workspace-declared gate over an action class.** An admin says "deleting records needs
   approval", in one place, for everything that isn't a person at the keyboard. It applies whatever any
   individual agent's own policy says.

All three land in the **same Inbox**, as the same kind of approval — there is one place to look, not
a screen per mechanism.

## Declaring a gate (workspace admins)

A gate is a **policy**: an *action class* (today `delete_records`), a **scope**, and a named
**approver**.

- **Scope is workspace, space or database**, and **the most specific one wins** — a database's
  policy beats its space's, which beats the workspace's. You can gate one database tightly and
  leave the rest alone.
- **The approver is a named person**, notified when something is held. A policy can be switched off
  and on without deleting it.
- **Admin-only, and API-only today.** `POST /api/v1/workspaces/{ws}/action-gates` with
  `{ action_class, space_id?, database_id?, approver_id }`, then `PATCH` to enable/disable or change
  the approver, `DELETE` to remove. There is no settings page for this yet.
- **An AI can read gates but never change them.** The MCP `list_action_gates` tool is read-only on
  purpose: an agent able to edit the gate meant to constrain agents would defeat it.

## What gets held

**Anything that isn't a person using the app** — an agent, an automation, an API token, an MCP
client, Tyron. A person clicking in the web app is never held by a gate. Who counts as a person is
decided at sign-in, never by a flag the caller sends.

The check runs **inside the delete itself**, so every way of reaching it is covered: the REST
endpoints, MCP's `delete_record` / `delete_records`, Tyron, and a large bulk job all hit the same
gate. Over MCP a held delete answers honestly — `deleted: false`, `pending_approval: true` and the
approval's id — never a success that didn't happen.

**Deleting a whole database or space doesn't dodge it.** A database delete is held as one approval
covering every live record in it. A **space** delete is refused (`422`) if any database inside it
would be gated, rather than half-deleting it; delete the gated database first, through the normal
hold-and-approve flow, then the space.

## Deciding

**An approval is a person's decision.** Approving or rejecting needs a signed-in person using the
app, in the **Inbox**; a request made with an API token or by a connected AI is refused with a
`403`, **even if that token belongs to an admin**. MCP has no approve or reject tool at all. Role
and named-approver rules are unchanged — this is an extra requirement on *who is acting*, not a
replacement for them.

**A decision is final.** Repeating the same decision (a double click) is harmless and returns the
request as it stands. The *opposite* decision — rejecting after approving, or the reverse — is refused
with a `409` and a reason, and so is any decision on an approval that has **expired**. Nothing is
changed. To undo what an approval allowed, change that thing directly.

## Not built

- Only the `delete_records` class can be declared as a policy, and the API enforces that:
  declaring any other name (say `delete_database`) is refused with a `422` that lists the
  supported classes, because a policy nothing checks would show as enabled and protect nothing.
  A policy stored on an unsupported class before this was enforced is kept, listed with
  `enforced: false` and an `inert_reason`, never reported as enabled, and can be disabled or
  deleted but not switched on. Other classes are named in the code but don't have policies yet,
  and nothing in the product spends money, so there is no spend gate.
- A web page for declaring gates.
