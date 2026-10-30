---
title: Approval gates
description: How StoryOS holds an AI's or an automation's action for a person's decision — four layers, one Inbox, and what a workspace admin can declare.
sidebar:
  order: 19
---

An **approval gate** stops an action until a person decides. It is enforced by the platform, not by
asking the AI nicely: an agent that ignores its instructions still cannot get past it.

## Four layers, one place to decide

1. **A rule's own approval flag.** An [automation](/concepts/automations/) action (an email, an
   outbound API call) can require approval, and some default to it.
2. **An agent's approval policy.** The owner of an [agent](/concepts/agent-runs/) can have its
   proposed writes wait for approval. This is a setting on that one agent — an owner who forgets to
   set it gets no gate.
3. **A workspace-declared gate over an action class.** An admin says "deleting records needs
   approval", in one place, for everything that isn't a person at the keyboard. It applies whatever any
   individual agent's own policy says.

4. **A gate on one agent's record writes.** An admin says "this agent's creates and updates need
   approval", optionally for one database and named fields. See [Gating an agent's record
   writes](#gating-an-agents-record-writes).

All four land in the **same Inbox**, as the same kind of approval — there is one place to look, not
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

## Gating an agent's record writes

A **write gate** holds one agent's record **create** and/or **update** until a person approves it.
Nothing is written while it waits.

**Declaring one (workspace admins, a person at the keyboard).**
`POST /api/v1/workspaces/{ws}/agent-write-gates` with

```json
{ "agent_id": "<the agent's record id>", "operations": ["create", "update"],
  "database_id": "<optional>", "fields": ["status"] }
```

- `operations` is `create`, `update` or both, and needs at least one.
- `database_id` limits the gate to one database; leave it out and the gate covers every database.
- `fields` (api names) limits the gate to a write that touches one of those fields; leave it out
  and any write is held. Naming fields needs a `database_id`, and a name the database does not have
  is refused with a `422`.
- `PATCH .../agent-write-gates/{id}` with `{ "enabled": false }` switches a gate off and on, and
  `DELETE` removes it. Like the approvals below, declaring or changing a gate needs a signed-in
  admin: an API token or a connected AI is refused, even one that belongs to an admin.
- API-only today; there is no settings page for it.

**What the agent sees.** A held write is not performed. The API answers `202` (not `200`, because
nothing was written) with:

```json
{ "pending_approval": true, "approval_id": "<id>", "message": "…" }
```

Over MCP the write call answers the same `pending_approval` and `approval_id`. Do not retry it.
Approving applies **exactly the values that were staged** when the write was held, and nothing the
agent or the approver sends afterwards. Rejecting discards them. A **batch create is held as one
approval** covering every record in it; it is approved or rejected whole.

**Who decides.** The held write lands in the Inbox as an ordinary approval, addressed to the
agent's owner, who is also notified. The owner or any workspace admin can decide it, and only as a
person in the app, as in [Deciding](#deciding). An approval whose agent no longer exists, or whose
owner is no longer an active member, is not applied.

**Where it applies.** The gate is checked inside the record write, so it covers an agent acting
through REST, an MCP connection that belongs to the agent, an agent run, a board drop that carries
new values, and a button an agent presses. In a bulk update, the records whose update was held are
reported in `held` with their approval ids, and the rest are changed as normal.

**Refused rather than held.** Some changes cannot be shown to an approver as one set of values, so
for a gated agent they are refused with a `422` that says to make the change as an ordinary create
or update instead:

- duplicating a record (counts as a create),
- restoring a record version (counts as an update),
- a bulk update job (counts as an update),
- linking or unlinking records through a relation (counts as an update).

The refusal applies only where a gate on that agent would match the database and operation. An
ungated agent, or a different database, is not affected.

**What it does not cover.**

- Only creates and updates. Deleting is the [action-class gate](#declaring-a-gate-workspace-admins).
- Only an agent that is a record in the Agents database, acting as that agent. A write by a person,
  or by an automation, is not held by this gate. A token that carries no agent is not either.
- A pack can declare gates (below), but a gate on an existing agent is never replaced by a pack
  update.

**Declaring gates in a pack.** An agent in a pack manifest can carry a `write_gates` list, each
entry `{ operations, database?, fields? }` using database and field **names**. Installing the pack
creates those gates for an agent the install creates; an agent that already exists keeps whatever
gates it has. Naming a database the pack does not declare, or a field the database does not have,
fails the install instead of dropping the gate. A key left out means "no opinion"; `[]` means
"explicitly none". Exporting a pack writes `write_gates` for an agent that has enabled gates.

**Reading them.** `GET /api/v1/workspaces/{ws}/agent-write-gates` (MCP `list_agent_write_gates`)
is read-only:

- an admin can read all gates, or one agent's with `?agent_id=`;
- an **agent's owner**, if a member, can read **that agent's** gates only, and must pass
  `agent_id`;
- anyone else, and an agent id that does not exist or is not theirs, gets the same `404`, so it
  does not reveal which;
- an agent's own token cannot read its own gates through its owner's access.

## What gets held

This section describes the action-class gate above.

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

## The Governance page

**Settings → Governance** (workspace admins only) shows what the server actually enforces, read-only.
Nothing on it widens a scope or decides an approval.

- **Agents.** Each agent's declared scope (read, read and change, or admin) and its own approval
  policy in plain words. An agent that declares no scope is shown as read-only, because that is what
  the server does. An enabled agent that can change records and holds nothing for approval is
  flagged; a switched-off agent is not. A banner appears only when *every* enabled agent that can
  change records has no approval policy *and* no workspace gate is in force.
- **Gates in force.** The workspace's gate policies, in-force ones first. A policy on an action the
  server doesn't enforce shows as **"Does nothing"**, with the server's reason, never as protection.
- **Approvals.** How many are waiting and, of the latest 100, how many were approved, rejected or
  expired, with who decided, when, and why. These are counts of the latest 100, not totals.
- **Recent agent actions.** What agents and API tokens changed, newest first (25 at a time), each with
  the credential that did it and the member it ran as. Select one for the full chain: the member, the
  credential (live or revoked), what it could reach and may do, the agent, and the action. An action
  with no recorded credential says so on its row, in words: it was made before credentials were
  tracked, or through a sign-in session or an OAuth connection. A row is never drawn with a blank link.
- **Always enforced.** Only a person can approve or reject; an approval is decided once; an agent
  never has more access than its owner; and publishing to the outside is held for approval unless an
  admin turns that off.

**What it cannot show.** The scopes and approval policies on the page describe a run **when StoryOS
runs the agent**. They do not describe an API token or a connected AI client, which act as the person
who made them. There is no audit export yet, and an action
made through a sign-in session, an OAuth connection or an automation, or before credentials were
tracked, names no credential, because none was recorded.

## Not built

- Only the `delete_records` class can be declared as a policy, and the API enforces that:
  declaring any other name (say `delete_database`) is refused with a `422` that lists the
  supported classes, because a policy nothing checks would show as enabled and protect nothing.
  A policy stored on an unsupported class before this was enforced is kept, listed with
  `enforced: false` and an `inert_reason`, never reported as enabled, and can be disabled or
  deleted but not switched on. Other classes are named in the code but don't have policies yet,
  and nothing in the product spends money, so there is no spend gate.
- A web page for declaring gates.
