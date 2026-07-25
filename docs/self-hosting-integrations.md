# Self-hosting integrations

Which external integrations work on a self-managed StoryOS box, and what — if
anything — you as the operator have to configure to enable each one.

Every provider under **Settings → Connections** declares a **tier** by *who owns
the credential*. The tier (not the auth mechanism) decides whether an integration
works out of the box, needs one-time operator setup, or is genuinely cloud-only.
The full model, truth table, and contributor checklist live in
[architecture/integration-tiers.md](architecture/integration-tiers.md); this page
is the operator-facing recipe.

> **The one rule that shapes this page:** an OAuth integration's per-user setup is
> **never** an end user's job. Users connect their *account* with one click; they
> never register an OAuth app or paste a client id/secret. Registering the OAuth
> app is a one-time **operator/env** task, done here — once — for everyone on your
> instance.

## Works out of the box (Tier A — user brings their own key)

These need **no operator setup at all**. Each user adds their own API key (or
SMTP/HTTP credential) under **Settings → Connections**; StoryOS verifies it and
stores it encrypted at rest. They are `connectable` on every deployment, hosted
or self-managed.

| Provider | Connection id | What the user supplies |
|---|---|---|
| Apify | `apify` | Personal API token (used by scheduled sources) |
| Resend | `resend` | Resend API key (+ a verified from-address for `send_email`) |
| SMTP | `smtp` | Host / port / from-address (optional user + pass) |
| HTTP | `http` | Bearer token, basic auth, or a custom header for the `http_request` action |

The **core** app — records, databases, views, automations, MCP — likewise needs
none of these; they are optional add-ons a user turns on per workspace.

## Operator-optional (Tier B — env-configured OAuth apps)

These connect over OAuth. On **StoryOS Cloud** they are one-click, because we
operate a verified OAuth app centrally. On a **self-managed** box there is no such
app until *you* register one and wire its client id/secret into the environment.
Until you do, the gallery shows the provider as **operator-only** (a
"Configured by your admin" hint) — never a dead Connect button, and never a
per-user "create your own app" wall. Once the env vars are set, the same provider
flips to **Connectable** for every user on the instance.

All of StoryOS's current Tier B providers are **Google** products and share a
single OAuth app — set **`GOOGLE_CLIENT_ID`** and **`GOOGLE_CLIENT_SECRET`** once
and every Google-backed connection lights up. (Note: **YouTube** rides on the
`google` connection — the same client id/secret, just a different scope; there is
no separate "YouTube" OAuth app to register.)

### One-time setup (Google)

1. In the Google Cloud console, create (or reuse) a project and an **OAuth 2.0
   Client ID** of type *Web application*.
2. Register these **authorized redirect URIs** (substitute your public
   `API_URL`). Both the login button and every Connections OAuth provider share
   the same two callbacks — you do **not** register a separate URI per provider:

   | Purpose | Redirect URI |
   |---|---|
   | "Continue with Google" (login) | `{API_URL}/api/v1/auth/callback/google` |
   | Connections (YouTube, Google Calendar) | `{API_URL}/api/v1/connections/oauth/callback` |

   For a local box that is `http://localhost:3001/api/v1/auth/callback/google` and
   `http://localhost:3001/api/v1/connections/oauth/callback`; for a real
   deployment use your public origin, e.g.
   `https://os.example.com/api/v1/connections/oauth/callback`.
3. Add the scopes each connection requests (below) on the OAuth consent screen. A
   self-managed app in *testing* mode works for a small team without Google
   verification; publishing / verification is only needed to remove the unverified-
   app warning for a wider audience.
4. Set the client id/secret in `.env` (they are already wired through
   `docker-compose.yml`):

   ```bash
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   ```

   Restart the `api` container. Both **YouTube** and **Google Calendar** become
   Connectable — no code change, no per-provider var.

### Tier B provider reference

| Provider | Connection id | Client id env | Client secret env | OAuth scopes |
|---|---|---|---|---|
| YouTube | `google` | `GOOGLE_CLIENT_ID` | `GOOGLE_CLIENT_SECRET` | `openid`, `email`, `https://www.googleapis.com/auth/youtube.readonly` |
| Google Calendar | `google-calendar` | `GOOGLE_CLIENT_ID` | `GOOGLE_CLIENT_SECRET` | `openid`, `email`, `https://www.googleapis.com/auth/calendar` |

Both request read-oriented Google scopes (YouTube is read-only; Calendar requests
`auth/calendar`). They are **separate connections on purpose** — connecting
Calendar must never silently widen the permissions of an unrelated YouTube
connection — but they read the *same* `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
A half-configured env (id set, secret blank, or vice-versa) counts as unconfigured
and keeps the provider operator-only.

## Cloud-only (Tier C — hosted StoryOS only)

**None today.** No integration is reserved to hosted StoryOS Cloud; there is no
Tier C (`hosted_only`) provider in the registry. If one is ever added, a
self-managed box will show it as **"Available on StoryOS Cloud"** (an upsell), and
this section will name it.

### Why managed OAuth apps are a Cloud convenience

A verified OAuth app's redirect URIs and provider verification are scoped to
StoryOS Cloud's own domain — a self-managed operator cannot reuse ours, which is
exactly why the Tier B one-time setup above exists. So "Google integrations work
with zero setup" is a genuine hosted-Cloud convenience, not something self-managed
can inherit for free. The trade is deliberate and honest: on self-managed you
supply your own Google app (once), and then it is entirely yours.

## See also

- [self-hosting.md](self-hosting.md) — full self-host guide and the complete
  environment matrix (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and the rest).
- [architecture/integration-tiers.md](architecture/integration-tiers.md) — the
  tier model, the `availabilityFor()` truth table, and the new-provider checklist.
