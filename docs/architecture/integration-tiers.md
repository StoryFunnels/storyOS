# Integration tiers: cloud vs self-managed

How StoryOS classifies every external integration so it behaves correctly on
**hosted StoryOS Cloud** and on a **self-managed** deployment — automatically,
for every provider we add. This is the standing convention from #344; #345/#346
built the runtime for it, #347 renders it, #348 documents the operator side.
This page is the enforcement artifact: it explains the model and carries the
**"Add an integration" checklist** every new provider must satisfy.

> **TL;DR** — every provider declares a `tier`. The server folds tier ×
> deployment-mode × operator-env into one `availability` verdict. The gallery
> renders that verdict verbatim. You never build per-user "go get an OAuth app"
> UI — Tier B OAuth apps are an operator/env concern.

## The problem

An integration that works on our hosted cloud does not automatically work on a
self-hosted box, and the reason is credential ownership:

- An **API-key** integration works everywhere — the user pastes their own key.
- An **OAuth** integration needs a *verified OAuth app* (registered client id +
  secret, with redirect URIs and provider verification). On hosted StoryOS we
  register and verify that app once, centrally, and every workspace uses it. A
  self-managed operator has no such app unless they register their own — and the
  redirect URIs + verification are scoped to `app.storyos.dev`, so they can't
  reuse ours.

Without a convention, each new OAuth provider risks shipping a dead "Connect"
button on self-managed, or leaking a per-user "create your own Google app" flow
that no end user should ever see. The tiers make the correct behavior fall out
of one declared field.

## The three tiers

Declared as `tier` on each provider's descriptor
(`apps/api/src/connections/providers/types.ts`), typed by `ProviderTier`
(`packages/schemas/src/connections.ts`,
`providerTierSchema = z.enum(['api_key', 'oauth_managed', 'hosted_only'])`).
`tier` is a **distinct axis from `authKind`** (the mechanical credential shape):
today every `oauth2` provider is `oauth_managed`, but the axes are independent.

| Tier | Value | Who owns the credential | Works on self-managed? | Current providers |
|---|---|---|---|---|
| **A** | `api_key` | The user brings their own key/secret | Yes, always | `apify`, `resend`, `smtp`, `http` |
| **B** | `oauth_managed` | A verified OAuth app — hosted provides the managed one; a self-managed operator brings their own via env | Yes, once the operator wires their own OAuth app | `google`, `google-calendar` |
| **C** | `hosted_only` | Only meaningful on hosted StoryOS | No — cloud only | *reserved; no provider uses it yet* |

Tier B is the interesting one: on hosted, the managed app "just works"; on
self-managed, the operator supplies their own app's client id/secret through the
descriptor's `clientIdEnv` / `clientSecretEnv` (`ProviderOAuthConfig`). Google,
for example, reads `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.

## The capability signal: `isHosted`

Whether *this* instance is hosted StoryOS Cloud or a self-managed box is
answered by `DeploymentService.isHosted`
(`apps/api/src/deployment/deployment.service.ts`). It is **derived from config,
never a build-time flag** (`resolveHosted()`):

- `STORYOS_HOSTED` set explicitly wins — `true`/`1` ⇒ hosted, `false`/`0` ⇒
  self-managed. The escape hatch for a hosted instance without Stripe yet, or a
  self-managed one that has it.
- `STORYOS_HOSTED` unset ⇒ hosted **iff** `STRIPE_SECRET_KEY` is set — reusing
  the same "billing configured ⇒ this is the paid, hosted product" signal
  `StripeService.enabled` already relies on.

So a plain self-host — no Stripe, no `STORYOS_HOSTED` — reads self-managed with
**zero new configuration**.

## The resolver: `availabilityFor()`

`availabilityFor(descriptor, { isHosted, env })`
(`apps/api/src/connections/providers/availability.ts`) folds tier ×
deployment-mode × operator-env-presence into one server-authoritative verdict,
typed by `ProviderAvailability`
(`providerAvailabilitySchema = z.enum(['connectable', 'operator_config', 'cloud_only'])`).

For Tier B it checks `env[oauth.clientIdEnv]` **and** `env[oauth.clientSecretEnv]`
are both present (a half-configured env — id only — counts as absent).

| `tier` | hosted? | OAuth env present | → `availability` | Meaning |
|---|---|---|---|---|
| `api_key` | any | n/a | `connectable` | Tier A works everywhere |
| `oauth_managed` | any | yes | `connectable` | operator (or hosted) wired the app |
| `oauth_managed` | hosted | no | `connectable` | hosted's managed app (belt-and-braces fallback) |
| `oauth_managed` | self | no | `operator_config` | "you can turn this on" — **not** an upsell |
| `hosted_only` | hosted | n/a | `connectable` | Tier C on cloud |
| `hosted_only` | self | n/a | `cloud_only` | genuinely unavailable off hosted |

The key distinction #346 encodes: a self-managed operator who simply hasn't
wired their OAuth app yet gets **`operator_config`** ("configure it"), **not**
the `cloud_only` upsell. `cloud_only` is reserved for what is *genuinely*
impossible off hosted (Tier C). Never route "unconfigured Tier B on
self-managed" into the cloud upsell.

### Where it's served

There is **no dedicated availability endpoint**. The existing provider catalog
carries it: `GET /workspaces/:ws/connections/providers`
(`ConnectionsController.providers` → `ConnectionsService.listProviders()`) now
returns `tier`, `availability`, optional `availability_note`, and
`oauth.configured` per provider (shape: `ProviderDescriptorSummary`). It's
server-authoritative: the deployment mode and operator env are already folded
in, so clients render the verdict verbatim without re-deriving anything.

## The three UI states (#347)

The connections gallery maps the `availability` verdict straight to one of three
states — it does **not** re-derive tier/deployment logic client-side:

| `availability` | Gallery state | Control |
|---|---|---|
| `connectable` | **Connectable** | live Connect / Add-key button |
| `cloud_only` | **"Available on StoryOS Cloud"** | upsell (uses `availability_note`), no Connect button |
| `operator_config` | **Operator-only** | "configure on the server" hint, no per-user key UI |

## The operator-env, not per-user-UI rule

Tier B OAuth-app setup is an **operator/env concern**, documented once in the
self-hosting docs (#348) — it is **never** surfaced as per-user "go create an
OAuth app / paste a client secret" UI. End users connect their *account*; they
never register an *app*. A self-managed operator sets `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` (and the redirect-URI note) once, in the environment; the
gallery then flips that provider from `operator_config` to `connectable` for
every user on that instance. If you find yourself adding a form field for a
client id or client secret, stop — that belongs in env + self-hosting docs.

## Why managed OAuth apps are a StoryOS Cloud benefit

This is deliberate cloud value, not an accident of implementation. A verified
OAuth app's **redirect URIs and provider verification are scoped to
`app.storyos.dev`** — a self-managed operator cannot reuse ours; they must
register and verify their own app against their own domain. So "OAuth
integrations work out of the box" is something hosted StoryOS Cloud provides and
self-managed structurally can't replicate without operator effort. The tier
model makes that a first-class, honestly-communicated difference (`operator_config`
= "you can do this yourself" for Tier B; `cloud_only` = "this is cloud-only" for
Tier C) rather than a broken button.

---

## "Add an integration" checklist

Every new connection provider PR must satisfy this. A short copy of the
essentials lives in `CLAUDE.md` so it applies by default.

- [ ] **Declare `tier`** on the provider descriptor
      (`apps/api/src/connections/providers/<name>.ts`) — `api_key`,
      `oauth_managed`, or `hosted_only`. It's required; pick by *who owns the
      credential*, not by the auth mechanism.
- [ ] **If Tier B (`oauth_managed`):** define `oauth.clientIdEnv` /
      `oauth.clientSecretEnv` on the descriptor. Do **not** add any per-user
      OAuth-app / client-secret setup UI. Add operator docs **and the
      redirect-URI note** to the self-hosting integrations page (#348).
- [ ] **Gallery renders the correct state in self-managed** — verify no dead /
      broken Connect button. Tier B with no operator env must show
      `operator_config` (configure hint), Tier C must show `cloud_only`
      (upsell), never a live Connect that 500s.
- [ ] **Update the self-hosting integrations docs page** — which env vars this
      provider needs (and, for Tier B, the redirect URI to register).
- [ ] **Add/extend availability tests** — assert the provider's `tier`
      classification and its `availabilityFor()` verdict across both deployment
      modes and (Tier B) env-present/absent
      (`apps/api/src/connections/providers/availability.test.ts`,
      `apps/api/src/connections/connections.service.test.ts`).
- [ ] Set an `availabilityNote` when the non-`connectable` state needs human
      copy (the "Available on StoryOS Cloud" line).

## Existing OAuth integrations to (re)build to this model

These OAuth integration tickets predate the convention (or are in flight) and
should be built/rebuilt to the tiered model above — declared `oauth_managed`,
env-driven on self-managed, availability-aware in the gallery, with operator
docs rather than per-user app UI. Documentation note only; this ADR does not
change their code:

- **#236**
- **#237**
- **#238**
- **#341**
- **Google Calendar** — already `oauth_managed` via #346; confirm its
  self-hosting operator docs + redirect-URI note land with #348.

## References

- Parent convention: #344 · runtime: #345 / #346 · gallery: #347 ·
  self-hosting operator docs: #348
- Code: `apps/api/src/connections/providers/types.ts` (`ProviderDescriptor.tier`),
  `apps/api/src/connections/providers/availability.ts` (`availabilityFor`),
  `apps/api/src/deployment/deployment.service.ts` (`DeploymentService.isHosted`),
  `packages/schemas/src/connections.ts` (`providerTierSchema`,
  `providerAvailabilitySchema`, `providerDescriptorSummarySchema`)
- Related: [auth.md](auth.md) (env-gated OAuth), [self-hosting.md](../self-hosting.md)
  (operator env vars)
