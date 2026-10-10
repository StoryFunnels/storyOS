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
   API. A PAT acts as its creator: same role, same [guest scoping](/concepts/access-and-roles/).
   **Shown once at creation.**

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
- **A bound token behaves like a guest limited to the listed items.** It sees them in lists and
  search, follows no relation out of them, and gets nothing derived through one (a lookup or rollup
  over a database outside the boundary comes back empty rather than carrying the value). A space
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
  token and revoke the old; the revoked row is kept, so what a token could reach stays answerable
  after the fact. Revoking takes effect on the very next request.
- `GET /api/v1/me` shows a credential its own boundary under `auth.resource_scope` (`null` =
  unrestricted), and `GET /api/v1/me/tokens` lists each token's.
- Tokens minted before this existed are unrestricted and keep working unchanged. Over OAuth (the
  claude.ai connector) there is no equivalent yet.
- Today it is set through the API only; the web token form does not offer it yet.

## Errors and rate limits

Every error uses one envelope:

```json
{ "error": { "code": "...", "message": "...", "details": [], "request_id": "req_..." } }
```

Rate limits are per credential (default 300 req/min) → `429` with a `Retry-After` header. See the
[conventions](/api/conventions/) for the full error and pagination model.
