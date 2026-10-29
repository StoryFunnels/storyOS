---
title: Authentication
description: Authenticate to the StoryOS API with session tokens or personal access tokens, sent as a Bearer credential.
sidebar:
  order: 2
---

Two credentials work everywhere, sent as `Authorization: Bearer <token>`:

1. **Session tokens** — returned in the `set-auth-token` response header on sign-in / sign-up. This
   is what the web app uses (as a cookie).
2. **Personal access tokens** (`mn_pat_…`) — created in the app under **API tokens**, or via the
   API. A PAT acts as its creator: same role, same [guest scoping](/concepts/access-and-roles/), and the
   same [restricted](/concepts/access-and-roles/#restricting-a-space-or-database) spaces and
   databases, checked on every request.
   **Shown once at creation.**

**A personal access token belongs to one workspace.** It is created for a single workspace (note
the `workspace_id` in the request below) and only works there; if you work in several, make one
token per workspace. The **API tokens** page lists the tokens of the workspace you're in; a
checkbox, *Show tokens from my other workspaces*, adds the rest, each labelled with its workspace.
Revoking a token that belongs to a different workspace asks you to confirm, naming both, so you
can't revoke one by accident from the wrong place.

## Sign in and mint a PAT with curl

```bash
API=http://localhost:3001

# session token from the response header
TOKEN=$(curl -si $API/api/v1/auth/sign-in/email \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"…"}' \
  | grep -i '^set-auth-token:' | cut -d' ' -f2 | tr -d '\r')

# workspace id
WS=$(curl -s $API/api/v1/workspaces -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id')

# mint a PAT (copy .token — it is never shown again)
curl -s -X POST $API/api/v1/me/tokens \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"my-script\",\"workspace_id\":\"$WS\"}" | jq
```

## Binding a token to specific spaces or databases

A token you hand to a script, an integration or a contractor's tool rarely needs everything your
role can reach. Mint it with `resource_scope` and it reaches **only** what is listed:

```bash
curl -s -X POST $API/api/v1/me/tokens \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"client-portal-sync\",\"workspace_id\":\"$WS\",
       \"resource_scope\":{\"database_ids\":[\"<database id>\"],\"space_ids\":[]}}" | jq
```

- **Never wider than you.** Every listed space or database must be one you can reach yourself; one
  you cannot is refused with the same `404` as one that does not exist. A guest's token can never
  reach beyond that guest's own grants, and narrowing the guest narrows their token on the next call.
  The same holds for a member: a token bound to a space opens a restricted database inside it only
  if its owner holds a grant directly on that database, and removing that grant closes it on the
  next call.
- **A bound token behaves like a guest limited to the listed items.** It sees them in lists and
  search, follows no relation out of them, and is not served values read through one (a lookup or
  rollup over a database outside the boundary comes back empty when you read a record). That is
  about reading values back: a *filter* over such a field can still tell a match from a non-match
  (tracked as ticket #881), so do not treat the boundary as hiding what those values are. A space
  covers every database in it, now and later.
- **Refused in words.** Asking for anything outside the boundary returns `403` saying the token is
  bound to specific spaces or databases, **identically whether or not the thing exists**, so the
  refusal is not a way to find out what is there. An agent is told it is the boundary, not that
  nothing exists. Through MCP, naming a database outside the boundary says the same.
- **Only the data routes are open to it.** Records, databases, fields, relations, views, comments,
  search and favourites, plus the two discovery calls an MCP client opens with. Everything else
  (members, settings, billing, notifications, approvals, automations, skills, exports, tokens) is
  refused to a bound token, and so is any route added later until it is deliberately opened.
- **Fixed at mint.** There is no way to widen or edit a token's scope. To narrow one, mint a new
  token and revoke the old. The revoked row is kept (and survives erasure of its owner, with the
  person stripped from it), so the scope it carried is not lost, and an admin can still read it:
  see [Which token did that](#which-token-did-that). Revoking takes effect on the very next request.
- `GET /api/v1/me` shows a credential its own boundary under `auth.resource_scope` (`null` =
  unrestricted), and `GET /api/v1/me/tokens` lists each token's.
- Tokens minted before this existed are unrestricted and keep working unchanged. Over OAuth (the
  claude.ai connector) there is no equivalent yet.
- Today it is set through the API only; the web token form does not offer it yet.

## Which token did that

When a script or an agent used a personal access token and something changed that nobody expected,
an admin can trace the change back to the token, including after the token was revoked.

- Every action made with a personal access token is stamped with that token's id: the activity
  event, and the version and field-change rows behind record history. An action made by a signed-in
  session, over OAuth or by an automation has no token id, and neither does anything recorded
  before this existed.
- The admin **audit log** (`GET /api/v1/workspaces/{ws}/audit-log`, MCP `list_audit_log`) shows it
  on each row as `credential_id`, so you can spot a token's rows in the list.
- `GET /api/v1/workspaces/{ws}/credentials/{id}` (MCP `get_credential`) returns what that token
  was: its name, power scope, `resource_scope` (`null` = unrestricted), when it was created and
  when it was revoked. It works for a revoked token and for a token whose owner has been erased.
- `GET /api/v1/workspaces/{ws}/credentials/{id}/actions` (MCP `list_credential_actions`) lists
  what that token did, newest first, 50 at a time with a `next_cursor`. Each row has the event
  type, the record, the source and the time.
- `GET /api/v1/workspaces/{ws}/activity-events/{id}` (MCP `get_activity_event`) takes one past
  action and returns the `credential_id` it was made with.

All three are **admin only**, and a token bound to specific spaces or databases is refused. They
return no person: no user id, email or token hash. The person behind an action is the actor on the
audit log row, which is a separate field. An id that is not in this workspace returns `404`.

## Errors and rate limits

Every error uses one envelope:

```json
{ "error": { "code": "...", "message": "...", "details": [], "request_id": "req_..." } }
```

Rate limits are per credential (default 300 req/min) → `429` with a `Retry-After` header. See the
[conventions](/api/conventions/) for the full error and pagination model.
