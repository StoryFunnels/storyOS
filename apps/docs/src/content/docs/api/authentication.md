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

## Errors and rate limits

Every error uses one envelope:

```json
{ "error": { "code": "...", "message": "...", "details": [], "request_id": "req_..." } }
```

Rate limits are per credential (default 300 req/min) → `429` with a `Retry-After` header. See the
[conventions](/api/conventions/) for the full error and pagination model.
