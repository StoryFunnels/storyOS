# API authentication

Two credentials work everywhere, sent as `Authorization: Bearer <token>`:

1. **Session tokens** — returned in the `set-auth-token` response header on sign-in/sign-up. What the web app uses (as a cookie).
2. **Personal access tokens** (`mn_pat_…`) — created in the app under **API tokens**, or via the API. A PAT acts as its creator: same role, same guest scoping. **Shown once at creation.**

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

Every error uses one envelope: `{"error":{"code","message","details?","request_id"}}`. Rate limits are per credential (default 300 req/min) → `429` + `Retry-After`.
