# Runner outward-tool gate audit (ticket #1135, precondition of the Claude Code adapter)

Written 2026-10-30 against the Runner stack head (PR #1355, `api/1132-run-credential`). ADR-0021 section 7 leaves one item open and makes it a precondition of the adapter: *"I have not verified that every MCP tool that has an outward effect ... is either gated or unreachable for a credential with `source = agent` at `write` scope."* This is that verification. It is enforced, not just written: `apps/api/test/run-credential-outward-sweep.test.ts` fails when a route or an MCP tool appears that this audit has not classified, and calls every route it calls unreachable with a real run credential.

## The answer

**Yes, for the effects this audit could find, after two fixes in this stack.** Before this audit a run credential could, with no approval: press a button (running an admin-authored `send_email` / `http_request` / `send_webhook` / `send_slack_message` action list), rotate an automation's hook token and read the new token and secret, re-run a rule's actions, switch on write-back on a Shopify source and push edits to the shop, run a paid Apify actor, submit a GitHub pull-request review (an APPROVE included), have the server GET a URL it chose (a channel out for anything it can read), and start a Tyron turn whose token is minted from its OWNER's role, so a write-capped credential of an admin's agent acted as admin. Those six are fixed in this PR by refusing run credentials (a new `@NoRunCredential()` marker, plus `allowRunButton: false` at mint).

The one class that remained was **ticket #1174** (High): **an agent's record writes fired admin-configured outward actions with no approval.** An external email went out after a run credential's plain `PATCH` of a record, through an admin-authored `send_email` rule with `require_approval: false` (reproduced, see F1). **#1174 is fixed** (Otto's ruling: stage where the agent can steer the destination or content, log where an admin fixed the destination): the event now carries the agent and the run that caused it, every outward automation action it fires is staged for a person, and the fixed destinations are logged with the agent. `run-credential-outward-staging.test.ts` is the proof. What this audit still does NOT cover is listed under Limits.

### Counts

| | Verdict | Routes (of 382 live) | MCP tools (of 205) |
|---|---|---|---|
| UNREACHABLE | the guards refuse a run credential (proven by a real request) | 193 (+ 12 self-guarded in the handler) | 89 |
| GATED | staged for a person, not performed | 3 | 3 |
| INTERNAL | nothing leaves StoryOS (reads return to the caller only) | 124 | 81 |
| PUBLIC | no `AuthGuard`: the credential neither grants nor widens anything | 23 | 0 |
| GATED / LOGGED by origin (#1174, was OUTWARD AND UNGATED) | record writes whose events reach configured outward actions: staged for a person, or logged with the agent | 27 | 24 |
| (no direct REST call) | MCP tools that go through helpers, each classified by hand in the test | | 8 |

Six findings were OUTWARD AND UNGATED when this audit started and are counted above as UNREACHABLE now (`no_run_credential` 20 routes incl. 8 Tyron routes, `run_button_flag` 1). A route whose mechanism is `scope_admin` needs an admin-scoped token, and a run credential is capped at `write`: that is 147 routes, including every outward one an admin can configure (webhooks, portal, invites, connections, credentials, share/publish, automations, packs, exports, billing).

## Method

1. **Enumerate from the live surfaces, never from a list.** The route table is read from the controllers' own metadata (`liveRoutes` in `apps/api/test/helpers/route-sweep.ts`, the same walk the restricted-resource sweeps use); the MCP tools are the `reg(` blocks of `packages/mcp/src/tools.ts`, each with the REST routes its source block calls. Both are cross-checked: a tool calling a route that does not exist fails the test.
2. **Decide by the thing that decides.** A route's verdict is DERIVED from its own guards where a guard decides it (`mechanismOf` in `apps/api/test/helpers/outward-audit.ts`), so a new route in a refused class needs no entry and cannot be forgotten. The routes a run credential CAN reach need an explicit entry (verdict + reason); a route that is neither fails the test with instructions. This replaces a hand-kept list, which CLAUDE.md rule 3 records as the thing that rots.
3. **Prove each refusal for its stated reason.** The sweep sends a real run credential (claimed over HTTP by a real paired Runner, not a forged `api_tokens` row) to every UNREACHABLE route and requires the refusal text of that mechanism (an admin-scope 403 says "write-scoped; admin access is required", a `@NoRunCredential` 403 says "Runner run credential cannot do this"). A 404 or a 400 would pass a status-only check for the wrong reason.
4. **Watch every sink.** During the sweep the mail driver, the `fetcher` seam of nine services (connections/Resend, sources, write-back, GitHub reviews, GitHub, Linear, Slack, outbound webhooks, calendar sync), node `http.request` / `https.request` and `fetch` record calls, and the rows an outward effect would leave (approvals, jobs, runs, webhook deliveries and subscriptions, sources, source runs, connections, attachments, files, notifications, write gates, tokens) are snapshotted. Both must be unchanged.
5. **Give each fix a control.** For the button, the hook rotation and Tyron, the same call by a person has the effect (the mail is sent, the new token is returned), so a refusal cannot be a fixture that could not have seen it.

### The mechanisms (UNREACHABLE)

| Mechanism | What refuses | Where |
|---|---|---|
| `scope_admin` (147 routes) | the run credential is `write` at most, and a route that needs the admin role needs an admin-scoped token for every method | cap `apps/api/src/tokens/run-credentials.service.ts:15`; applied `apps/api/src/tokens/run-credentials.service.ts:84`; rule `apps/api/src/auth/auth.guard.ts:41`; check `apps/api/src/auth/auth.guard.ts:138` |
| `session_only` (10) | account-level routes with no `:ws` | `apps/api/src/auth/auth.guard.ts:134` |
| `no_run_credential` (20) | a route marked `@NoRunCredential()` (#1135); only a run credential carries the run stamp | marker `apps/api/src/auth/token-scope.guard.ts:33`; check `apps/api/src/auth/auth.guard.ts:218` |
| `run_button_flag` (1) | the credential is minted with `allowRunButton: false` | mint `apps/api/src/tokens/run-credentials.service.ts:100`; check `apps/api/src/auth/auth.guard.ts:147` |
| `platform_admin_session` (11, `/admin`) | platform admin routes need a signed-in session | `apps/api/src/admin/platform-admin.guard.ts:22` |
| `runner_token_only` (4, `/runner/v1/*`) | an `mn_run_` token only; a `mn_pat_` credential is a 401 | `apps/api/src/runners/runner-auth.guard.ts:25`; `apps/api/src/auth/auth.guard.ts:188` |
| self-guarded in the handler (12) | `assertPerson` (Runner pairing, assignment) and `assertSession` (token management), `/oauth/consent` | `apps/api/src/runners/runners.controller.ts:20`; `apps/api/src/tokens/tokens.controller.ts:36` |
| approvals decide | approve / reject are admin-scoped AND `assertHumanSource` (a run credential's source is `agent`) | `apps/api/src/automations/approvals.controller.ts:73`; `apps/api/src/auth/assert-human-source.ts:14` |

## Findings

### F1 (FIXED by ticket #1174, was High): record writes fired configured outward actions with no approval

`DomainEvent` carries no `source` (`apps/api/src/events/domain-events.service.ts:3`), so a rule fired by an agent's write runs its action list (`apps/api/src/automations/automations.service.ts:636`) without knowing an agent caused it. Gating exists per action kind only: `send_email` is held unless every recipient is a member or the author turned approval off (`apps/api/src/automations/actions.service.ts:984`, `apps/api/src/automations/actions.service.ts:991`); `post_social` is held by class (`apps/api/src/action-gates/action-classes.ts:54`); `send_slack_message`, `send_webhook` and `http_request` are never held by default (`apps/api/src/action-gates/action-classes.ts:50`). The same event also reaches outbound webhook subscriptions (`apps/api/src/webhooks/webhooks.service.ts:64`), the Slack mirror of an @mention comment (`apps/api/src/comments/comments.service.ts:436`, to the workspace's default channel; member emails go only to members who can read the record, `apps/api/src/comments/comments.service.ts:405`), watcher emails (`apps/api/src/records/watcher-email.service.ts:68`) and write-back for a source with `write_back` on and `require_approval_for_push` off (`apps/api/src/sources/write-back.subscriber.ts:146`, `apps/api/src/sources/write-back.subscriber.ts:151`).

**Repro (run during this audit, a real claimed run credential):** an admin saves a `record_updated` rule on a database with action `send_email` to `{Email}`, `require_approval: false`; the run credential does `PATCH /workspaces/:ws/databases/:db/records/:rec` with `Email = outsider@external.example`; after the engine settles and the job runner ticks, one email was sent through the connection. No approval row.

**Also not honoured on this path:** the agent's own `approval_policy` (delete / webhook / email / run_button / outward). It is read only where a server-run agent stages a proposed action (`apps/api/src/agents/agents.service.ts:1099`, `apps/api/src/agents/agents.service.ts:1338`); a Runner agent calls tools directly. The #1104 agent write gate (`apps/api/src/action-gates/agent-write-gates.service.ts:12`: `create` and `update` only) and the #542 delete policy (`apps/api/src/action-gates/action-gates.service.ts:137`) hold a write only if a manager declared one: both are opt-in.

**The fix (ticket #1174, Otto's ruling: option (a), scoped to where the agent can steer the destination or content).**

- `DomainEvent.origin` (agent id and name, run, Runner) is stamped in `DomainEventsService.emit()` from the run credential's request context, so no emit site has to remember it. It rides in `ActionContext`, in every job payload and approval snapshot, and in a new `bulk_record_jobs.origin` column (the one hand-off with nowhere else to keep it), because the request context does not survive a database row. A write an automation action makes keeps it, so a chain of rules is held at every outward step.
- An event with an origin STAGES every outward automation action (`OUTWARD_AUTOMATION_ACTION_TYPES` in `action-classes.ts`: `send_email`, `send_slack_message`, `send_webhook`, `http_request`, `post_social`) whatever the rule's `require_approval` says. The one exception is a `send_email` whose RENDERED recipients (to and cc, after `{Email}` has been replaced by the record's value, which the agent may have just written) are all active members: it runs as configured. An address or URL taken from a record field is therefore held whenever it resolves outside the workspace.
- The agent's own `approval_policy` now applies on this path: a policy that lists `email` (or `outward`) holds even a member-only email.
- The approval card says `Caused by agent "X" (run N, on Runner): ...` and the snapshot's `ctx.origin` carries the ids. Approving runs the frozen snapshot; the approve endpoint is admin-scoped, so a run credential cannot decide its own approval. Approving a held `send_webhook` or `send_slack_message` did nothing before this change (no job executor was registered for either kind); both now have approved-only executors.
- Destinations an admin fixed run as configured and are LOGGED with the agent: outbound webhook subscriptions (the delivery payload gains `caused_by`), the Slack mention mirror, mention emails and watcher emails (an `outward.*` row in `activity_events`, visible in the audit log), and write-back on a source opted out of approval (`source_runs.stats.caused_by`).

**What it does not do, stated plainly.** An ordinary personal access token (not a run credential) and a server-run agent have no origin, so their writes behave as before (a server-run agent stages through `agents.service.ts` already). The agent's own `delete` policy is not applied to the credential's direct `DELETE` route: that route is the #542 gate's, and no automation action deletes. The cascade of an action a person approved keeps the agent origin, so a second approval can be asked further down the chain.

### F7 (FIXED by ticket #1178, was High): the agent's own `delete` approval policy did not apply to a run credential's direct DELETE routes

An agent's `approval_policy` can list `delete`, but that policy was read in one place only (`apps/api/src/agents/agents.service.ts`, where a server-run agent stages a proposed action). A run credential calling `DELETE …/records/:rec` (or a comment, an attachment, a source, a skill, a space view, "remove sample data") directly was not held by it; only a manager-declared #542 gate could hold the two record routes, and nothing held the rest. Reproduced first with a real run credential: `DELETE` answered 200 `{"deleted":true}` and the record was gone, no approval row.

The fix is one shared guard, `AgentDeleteHoldService.holdIfAgentPolicy` (`apps/api/src/action-gates/agent-delete-hold.service.ts`), called from inside each owning service's delete after that service's own access checks. It holds only when the caller is a run credential (the #1174 origin is set for nothing else, so a person, an ordinary token, an automation and a server-run agent are untouched and a server-run agent is never staged twice), the agent's `approval_policy` lists `delete`, and the delete is not the one a person just approved. A held delete is ONE `approvals` row (snapshot `agent_delete`, the card reads `Caused by agent "X" (run N, on Runner): delete …`) and the API answers 202 `{ pending_approval, approval_id, message }`, the #1104 shape. A manager-declared #542 gate is checked first and wins, so one delete is one approval. Approving runs the owning service's registered applier as the acting member, re-authorised at that moment (#1029), with the agent and the run on the audit row; the approve route is unchanged (admin scope and `assertHumanSource`), so the credential cannot approve its own.

The ten routes a run credential can reach that delete shared content carry `@HoldsAgentDeletes(kind)` and are listed in `HELD_DELETE_ROUTES` (`apps/api/test/helpers/outward-audit.ts`): record delete, records batch-delete, link removal, comment, attachment, document, source, skill, space view, remove sample data. Twelve more `DELETE` routes clear only the member's own preference or are refused inside the handler for a credential (`OWN_STATE_DELETE_ROUTES`, each with its reason); the admin-scope ones (databases, fields, spaces, folders, relations and the rest) are refused by the scope cap and are proven by the sweep as before. The sweep fails on a delete-capable route a run credential can reach that is none of those, and `run-credential-delete-policy.test.ts` calls every held route with a real credential and fails on a held route that has no fixture.

Judgement calls: a document, space view or skill that is PERSONAL keeps its title off the card (an approval is listed to admins; personal content is private from them); a delete that finds nothing to delete is not held; the own-state routes are not held (nothing shared is lost).

### Fixed in this PR (each was OUTWARD AND UNGATED; each is now refused to a run credential only, a person and a PAT are unaffected)

| # | Route / tool | What a run credential could do | Why it was ungated | Fix |
|---|---|---|---|---|
| F2 | `POST .../buttons/:field/press`, `run_button` | run the button's action list: send_email to a member without approval, http_request, send_webhook, send_slack_message | the press executes the list as the presser (`apps/api/src/automations/buttons.controller.ts:62`); `allowRunButton` was `scope === write` | `allowRunButton: false` at mint (`apps/api/src/tokens/run-credentials.service.ts:100`); the MCP tool is not advertised without it |
| F3 | `POST .../automations/:id/regenerate-hook` | rotate a `webhook_received` rule's token and secret, and READ the new ones from the response; with them, fire the rule through the public receiver (`apps/api/src/automations/hooks.controller.ts:107`) with any payload | route deliberately `@RequiresScope(write)` inside an admin-scoped controller; the response is the full rule (`apps/api/src/automations/automations.service.ts:299`) | `@NoRunCredential()` |
| F4 | `POST/PATCH .../sources`, `POST .../sources/:id/sync-now`, `POST .../sources/discover` (`create_source`, `update_source`, `sync_source`, `discover_source_fields`) | create a source with `write_back: true` and `require_approval_for_push: false` (default false, `apps/api/src/sources/sources.service.ts:71`) on the workspace's Shopify connection, then edit a record: the edit is pushed to the shop (`apps/api/src/sources/providers/shopify.ts:321`, `apps/api/src/sources/write-back.subscriber.ts:151`). Create an Apify source and run a paid actor under the workspace's Apify account with agent-chosen input (`apps/api/src/sources/providers/apify.ts:182`) | `write` scope, creator access | `@NoRunCredential()` on the four writes |
| F5 | all `.../tyron/threads` routes | `takeTurn` mints Tyron's token from the caller's OWNER role (`apps/api/src/agents/tyron/tyron.service.ts:204`): an admin-owned agent's write-capped credential becomes an admin-scoped Tyron. `confirm` lets the agent approve its own pending action. The threads are the owner's private conversations | the route has no scope or source check | `@NoRunCredential()` on the controller (`apps/api/src/agents/tyron/threads.controller.ts:56`) |
| F6a | GitHub review writes: `.../reviews`, `.../comments`, `.../replies`, `.../reactions` | post comments and submit a PR review, an APPROVE included, on any connected repo with the workspace's GitHub credential (`apps/api/src/integrations/github-reviews.service.ts:144`, repos limited by `apps/api/src/integrations/github-reviews.service.ts:169`) | `@MinRole(member)` | `@NoRunCredential()` (`apps/api/src/integrations/integrations.controller.ts:419`) |
| F6b | `POST .../runs/:id/rerun`, `.../actions/:index/rerun` (`rerun_run`, `rerun_action`) | re-fire a rule's actions (`apps/api/src/runs/runs.service.ts:314`) or replay a failed job with its frozen payload (`apps/api/src/runs/runs.service.ts:411`), ungated kinds included | `write` scope, editor access | `@NoRunCredential()` |
| F6c | `POST .../attachments/from-url` (`attach_file`) | the server GETs a URL the caller chose (`apps/api/src/attachments/attachments.service.ts:99`): the URL (path and query) is a channel out for anything the credential can read, to any public host | SSRF-guarded, not destination-guarded | `@NoRunCredential()` |

These are refusals, not approvals: a Runner agent has no staging path for them yet. If Otto wants any of them back for agents, the replacement is a staging step (the `approvals` flow), never silence; the sweep then moves the entry from `no_run_credential` to `gated` and shows it staged.

**How each was established, honestly.** The same calls were made with a real run credential and the marker and the mint flag temporarily disabled: the button press answered 201 and ran its actions; `regenerate-hook` answered 201 with the rule (token and secret in it); a Tyron thread create answered 201. `sources.create`, the GitHub review, `rerun` and `from-url` passed every guard and reached their service (404 "Connection not found", 403 "repository is not connected", 404 "Run not found", 422 "Could not fetch that URL"): the audit has no connected Shopify, GitHub or Apify account, so the outward effect of those four, and of a Tyron TURN (it needs a model key), is from reading the code cited, not from an executed run. F1 is the exception: it was executed end to end.

## Candidate table: everything the brief named, one verdict each

| Candidate (route / tool) | Outward effect | Reach for a run credential (write, source agent) | Verdict |
|---|---|---|---|
| `POST /invites`, `/invites/:id/resend`, `list_invites` | invite email to any address | `@MinRole(admin)` so admin scope (`apps/api/src/auth/auth.guard.ts:41`), above the cap (`apps/api/src/tokens/run-credentials.service.ts:15`) | UNREACHABLE |
| members and roles (`PATCH/DELETE /members/:m`), grants, `list_grants` | changes who may do what | admin scope as above; MCP has no write tool for them (coverage.ts) | UNREACHABLE |
| `/billing/*` (checkout, portal, AI-credit top-up) | spends money | admin scope | UNREACHABLE |
| outbound webhooks: `POST/PATCH/DELETE /webhooks`, `list_webhooks`, `update_webhook`, `list_webhook_deliveries` | delivers events to an external URL | admin scope (#1049) | UNREACHABLE |
| webhook DELIVERY of a record event to an existing subscription (`apps/api/src/webhooks/webhooks.service.ts:64`) | record data to an admin-chosen URL | any record write | LOGGED with the agent (delivery payload `caused_by`), runs as configured: #1174 |
| inbound `POST /hooks/:slug/:token` | fires a rule's actions | public, token + HMAC; the only way a run credential could learn a token was regenerate-hook (F3) | PUBLIC (token unreachable: F3 fixed) |
| `create_automation`, `update_automation`, `delete_automation`, `test_automation`, `get_automation` | authors / runs outward actions | `@RequiresScope(admin)` on the controller | UNREACHABLE |
| `run_button` / `POST .../buttons/:field/press` | runs the button's outward actions | was reachable; `allowRunButton: false` (`apps/api/src/auth/auth.guard.ts:147`) | FIXED, now UNREACHABLE (F2) |
| `rerun_run`, `rerun_action` | re-fires rule actions | was reachable at write | FIXED, now UNREACHABLE (F6b) |
| rule actions `send_email`, `post_social`, `send_slack_message`, `send_webhook`, `http_request`, `youtube_upload` fired by an agent's record write | email / public post / Slack / HTTP | send_email held by default (`apps/api/src/automations/actions.service.ts:984`), post_social held by class (`apps/api/src/action-gates/action-classes.ts:54`), the rest not; an admin may turn approval off | STAGED for an agent's write: all five outward kinds, whatever `require_approval` says; a member-only email is the one exception (#1174) |
| @mention in `add_comment` (`POST .../comments`) | email to mentioned MEMBERS; Slack mirror to the workspace channel; wakes a mentioned agent | any write; recipients are members who can read the record (`apps/api/src/comments/comments.service.ts:405`; a non-member is dropped, `apps/api/src/notifications/notifications.service.ts:296`), never an external address (`apps/api/src/comments/comments.service.ts:413`); channel mirror `apps/api/src/comments/comments.service.ts:436`; the wake is depth-limited and goes to a Runner, not out (`apps/api/src/comments/comments.service.ts:376`) | LOGGED with the agent, runs as configured (members and the workspace channel only, no external address): #1174 |
| watcher emails on a record change | email to watching members | `apps/api/src/records/watcher-email.service.ts:68` (readable members only, capped) | LOGGED with the agent, members only: #1174 |
| `create_portal_recipient`, `rotate_portal_recipient`, `revoke_portal_recipient`, `list_portal_*` | gives an external person a portal link; rotates it | `@MinRole(admin)` | UNREACHABLE |
| `share_view`, `unshare_view`, `publish_view` | public view link / publishes | `@RequiresScope(admin)` on the views controller (the share and publish routes) | UNREACHABLE |
| `create_skill` / `update_skill` / `import_skill` with `visibility: public` | an unauthenticated public link | a non-human author gets a PERSONAL skill and an approval a person decides (`apps/api/src/skills/skills.service.ts:299`, `apps/api/src/automations/skill-publish-gate.service.ts:40`); approve is human-only (`apps/api/src/auth/assert-human-source.ts:14`) | GATED (proven: 1 approval raised, skill not public, the credential cannot decide it) |
| `get_credential`, `list_credential_actions`, `get_activity_event` | reads connection credential actions and event payloads | `@RequiresScope(admin)` | UNREACHABLE |
| `/connections` create / update / delete / test / resume / oauth start | stores or exercises a third-party credential | `@RequiresScope(admin)` | UNREACHABLE |
| `list_connections`, `list_connection_providers` | none (auth material is never returned, `apps/api/src/connections/connections.service.ts:227`) | read | INTERNAL |
| `create_source`, `update_source`, `sync_source`, `discover_source_fields` | third-party call with the workspace credential; Shopify push; Apify run (paid) | was reachable at write | FIXED, now UNREACHABLE (F4) |
| `delete_source`, `list_sources`, `list_source_runs`, `list_source_providers`, `list_youtube_channels` | none (read, or stops a sync) | read / editor | INTERNAL |
| Slack `/integrations/slack/*`, GitHub config / sync, Linear, Google Calendar bindings | third-party config and writes | admin scope | UNREACHABLE |
| GitHub review writes | PR comment, reply, reaction, review (APPROVE) | was reachable at write, member role | FIXED, now UNREACHABLE (F6a) |
| Shopify catalogue provision (`POST /integrations/shopify/catalogue`) | reads Shopify into new databases | creates sources with `config: {}` (`apps/api/src/integrations/shopify-catalogue.service.ts:118`), write-back off | INTERNAL (inbound read) |
| `run_skill` | none: returns a step log, no model call (`apps/api/src/skills/skills.service.ts:581`) | write | INTERNAL |
| `run_agent`, `delegate_to_agent`, `create_agent_trigger`, `setup_agents`, `get_agents`, agent run approve / reject | spawns agents, spends credits | `@MinRole(admin)` | UNREACHABLE |
| Tyron threads and turns | spends AI credits; acts with the owner's ROLE; self-confirm | was reachable; `@NoRunCredential()` on the controller | FIXED, now UNREACHABLE (F5) |
| `attach_file` (`from-url`) | server-side GET of a caller-chosen URL | was reachable | FIXED, now UNREACHABLE (F6c) |
| `POST /files`, `POST /files/:id/download-url`, attachment upload / delete | a capability or signed URL for the caller | write; leaves StoryOS only if another outward route carries it | INTERNAL |
| `POST /me/tokens`, `DELETE /me/tokens/:id`, `DELETE /me/ai-connections/:id`, `/oauth/consent` | mints / revokes credentials | self-guarded (`apps/api/src/tokens/tokens.controller.ts:36`) | UNREACHABLE |
| Runner pairing, activation, assignment, removal | decides where an agent's work and data go | self-guarded (`apps/api/src/runners/runners.controller.ts:20`) | UNREACHABLE |
| `/runner/v1/*` | claim, complete | an `mn_run_` token only (`apps/api/src/auth/auth.guard.ts:188`) | UNREACHABLE |
| approvals approve / reject; agent write gates and action gate policies (create / update / delete) | an agent decides or removes its own gate | admin scope; approve and reject also `apps/api/src/automations/approvals.controller.ts:73` | UNREACHABLE |
| `GET /export/workspace.zip`, `export_pack`, `POST /packs/install`, `install_pack`, `uninstall_pack`, GDPR export / anonymize, `POST /me/gdpr/erase` | whole-workspace data leaving; erasure; installs (#1107 installs outward automations OFF) | admin scope, or session-only (erase) | UNREACHABLE |
| `GET /databases/:db/export/csv`, document Markdown / PDF export, `export_skill` | returns the caller's own data to the caller (PDF goes to the operator's Gotenberg, `apps/api/src/documents/export/pdf-renderer.ts:157`) | read | INTERNAL (the data reaches the caller, and through it the model vendor: inherent to the Runner, not gateable here) |
| `delete_record`, `delete_records`, `restore_*` | soft delete (restorable); not outward | write; held only if a delete policy exists (`apps/api/src/action-gates/action-gates.service.ts:137`); the agent's own `approval_policy: delete` is not consulted (`apps/api/src/agents/agents.service.ts:1338`) | unchanged by #1174: the credential's own delete is the #542 gate's (opt-in), and the agent's `approval_policy: delete` is still not consulted on that route |
| `create_record`, `update_record`, `upsert`, batch, link, move, import, copy, duplicate, version restore, document edits | internal data; events fan out (F1) | write; the #1104 gate holds `create` and `update` only if declared (`apps/api/src/action-gates/agent-write-gates.service.ts:12`), and was shown staging a run credential's create (202, nothing written) | fan-out STAGED or LOGGED by origin (#1174); GATED when a gate is declared |
| personal space / views / pinned tabs / favorites / hints / notifications / search / my-work | none | write / read, the owner's own | INTERNAL |
| `/admin/*` platform admin | platform operations | `apps/api/src/admin/platform-admin.guard.ts:22` | UNREACHABLE |
| public and inbound routes (forms, files, skills, views, packs, webhooks, OAuth callbacks, health, docs) | inbound or read-only public | no `AuthGuard`: a run credential changes nothing | PUBLIC |

## What was NOT covered

- **Reads are not outward here, but they are not free.** A run credential reads whatever its owner reads (records, comments, the owner's personal space, CSV export). That data reaches the model vendor through the Runner by design. The audit gates effects, not reads; ADR-0021 section 7 and #1140 own the confidentiality side.
- **Native tools of the CLI session.** Whether the adapter can do outward things through its own tools (shell, web fetch) is the adapter's allowlist, not a StoryOS route. This audit covers only what the StoryOS credential reaches.
- **Legacy agent tokens and PATs** (`mn_pat_` minted by a person) are not run credentials: `@NoRunCredential()` does not apply to them, and a PAT with `write` scope still reaches everything above. They were out of scope; the scope cap and `allowRunButton` are properties of a run credential.
- **The MCP tool column is derived by reading each `reg(` block of tools.ts.** The regex over-approximates for the last tool of a group (it can pick up a route from code after the block, for example `list_source_runs` shows a `GET /webhooks`). The ENFORCEMENT is per route, so an over-attribution can only make a tool look worse. Tools that call a route through a helper are in `LOCAL_TOOLS` in the test with a reason.
- **The sweep refuses with empty or minimal bodies** and, for the handlers that validate a body before they refuse, with a body that passes validation. A route whose refusal depends on a database row that exists was not separately exercised beyond the guards (the guard-level refusals, which are all of the derived ones, do not depend on the row).
- **A run credential's liveness over time.** The credential slides with the 90 s lease (#1132); this audit uses a freshly claimed one and does not test expiry, which `run-credentials.test.ts` owns.
- **Operator-configured fan-out is accepted as configuration by this audit** only where it ends at members or the workspace's own channel; where it ends at an external address or URL it is staged (F1, fixed by #1174).
- **Open decision for Otto:** whether the refusals above (F2 to F6c) should become staging (approval) steps for agents. F1 / #1174 is decided and built; the same staging can replace a refusal later.

## Keeping this true

- A new route that no guard refuses fails `run-credential-outward-sweep.test.ts` until it has a verdict in `apps/api/test/helpers/outward-audit.ts`. If it leaves StoryOS and has no approval step, mark it `@NoRunCredential()` (the sweep then proves the refusal) instead of writing `internal`. An `internal` entry whose path says webhook, slack, email, publish, share, invite, portal, credential, rotate or export must start its reason with `reviewed:`.
- A new DELETE (or delete/remove/purge/unlink) route a run credential can reach fails the sweep until it carries `@HoldsAgentDeletes(kind)` and calls `AgentDeleteHoldService.holdIfAgentPolicy` (F7, ticket #1178), or is listed in `OWN_STATE_DELETE_ROUTES`. The limit of that enumeration is its words: a route that deletes under a name without delete/remove/purge/unlink, and is not a `DELETE`, is only found by the all-routes review above.
- A new MCP tool is classified from the routes it calls; a tool that calls no route directly must be added to `LOCAL_TOOLS` with a reason.
- Regenerate the tool table below with `OUTWARD_AUDIT_DUMP=/path/audit.json pnpm --filter @storyos/api test run-credential-outward-sweep`.
- Mutation-checked: removing `@NoRunCredential()` from `SourcesController.create`, from `TyronThreadsController`, or `allowRunButton: false` from the mint fails the sweep (see the PR for the output).

## Appendix A: every MCP tool and its verdict (snapshot at this commit)

Verdict is taken from the routes the tool calls that are not a plain GET (a tool that only reads is INTERNAL). `unreachable` means every such route is refused to a run credential, so the tool fails with 403 when called.

| Tool | Verdict | Routes (effect routes first) |
|---|---|---|
| `add_comment` | gated | `POST /workspaces/:p/databases/:p/records/:p/comments` (gated); `GET /workspaces/:p/databases/:p/records/trash` (internal) |
| `add_field` | unreachable | `POST /workspaces/:p/databases/:p/fields` (unreach:scope_admin) |
| `apply_template` | internal | `POST /workspaces/:p/templates/:p/apply` (internal) |
| `attach_file` | unreachable | `GET /workspaces/:p/databases/:p` (internal); `POST /workspaces/:p/databases/:p/records/:p/attachments/from-url` (unreach:no_run_credential) |
| `browse_pack_marketplace` | internal | `GET /packs/marketplace/:p` (internal); `GET /packs/marketplace` (internal) |
| `build_schema` | unreachable | `POST /workspaces/:p/architect/build` (unreach:scope_admin) |
| `change_field_type` | unreachable | `POST /workspaces/:p/databases/:p/fields/:p/change-type` (unreach:scope_admin) |
| `convert_members_relation_to_user_field` | unreachable | `POST /workspaces/:p/databases/:p/fields/:p/convert-to-user` (unreach:scope_admin) |
| `convert_user_field_to_members_relation` | unreachable | `POST /workspaces/:p/databases/:p/fields/:p/convert-to-members-relation` (unreach:scope_admin) |
| `copy_document_to_personal_space` | internal | `POST /workspaces/:p/documents/:p/copy-to-personal` (internal) |
| `copy_records` | gated | `POST /workspaces/:p/databases/:p/records/copy` (gated) |
| `copy_view_to_personal_space` | internal | `POST /workspaces/:p/databases/:p/views/:p/copy-to-personal` (internal) |
| `count_records` | internal | `POST /workspaces/:p/databases/:p/records/aggregate` (internal) |
| `count_records_grouped` | internal | `POST /workspaces/:p/databases/:p/records/aggregate/grouped` (internal) |
| `create_agent_trigger` | unreachable | `POST /workspaces/:p/agents/triggers` (unreach:scope_admin) |
| `create_automation` | unreachable | `POST /workspaces/:p/databases/:p/automations` (unreach:scope_admin) |
| `create_database` | unreachable | `POST /workspaces/:p/databases` (unreach:scope_admin) |
| `create_document` | gated | `POST /workspaces/:p/spaces/:p/documents` (gated); `PATCH /workspaces/:p/documents/:p` (gated) |
| `create_folder` | unreachable | `POST /workspaces/:p/spaces/:p/folders` (unreach:scope_admin) |
| `create_personal_view` | internal | `POST /workspaces/:p/databases/:p/views/personal` (internal) |
| `create_portal_recipient` | unreachable | `POST /workspaces/:p/portal-recipients` (unreach:scope_admin) |
| `create_record` | gated | `POST /workspaces/:p/databases/:p/records` (gated) |
| `create_records` | gated | `POST /workspaces/:p/databases/:p/records/batch` (gated) |
| `create_relation` | unreachable | `POST /workspaces/:p/relations` (unreach:scope_admin) |
| `create_skill` | gated | `POST /workspaces/:p/skills` (gated) |
| `create_source` | unreachable | `POST /workspaces/:p/databases/:p/sources` (unreach:no_run_credential) |
| `create_space` | unreachable | `POST /workspaces/:p/spaces` (unreach:scope_admin) |
| `create_space_group` | unreachable | `POST /workspaces/:p/space-groups` (unreach:scope_admin) |
| `create_space_view` | internal | `POST /workspaces/:p/spaces/:p/views` (internal) |
| `create_view` | unreachable | `POST /workspaces/:p/databases/:p/views` (unreach:scope_admin) |
| `delegate_to_agent` | unreachable | `POST /workspaces/:p/agents/:p/delegate` (unreach:scope_admin) |
| `delete_attachment` | internal | `DELETE /workspaces/:p/databases/:p/records/:p/attachments/:p` (internal) |
| `delete_automation` | unreachable | `DELETE /workspaces/:p/databases/:p/automations/:p` (unreach:scope_admin) |
| `delete_comment` | internal | `DELETE /workspaces/:p/databases/:p/records/:p/comments/:p` (internal) |
| `delete_database` | unreachable | `DELETE /workspaces/:p/databases/:p` (unreach:scope_admin) |
| `delete_document` | internal | `GET /workspaces/:p/documents/:p` (internal); `DELETE /workspaces/:p/documents/:p` (internal) |
| `delete_field` | unreachable | `DELETE /workspaces/:p/databases/:p/fields/:p` (unreach:scope_admin) |
| `delete_folder` | unreachable | `DELETE /workspaces/:p/folders/:p` (unreach:scope_admin) |
| `delete_record` | gated | `DELETE /workspaces/:p/databases/:p/records/:p` (gated) |
| `delete_records` | gated | `POST /workspaces/:p/databases/:p/records/batch-delete` (gated) |
| `delete_relation` | unreachable | `DELETE /workspaces/:p/relations/:p` (unreach:scope_admin) |
| `delete_skill` | internal | `DELETE /workspaces/:p/skills/:p` (internal) |
| `delete_source` | internal | `DELETE /workspaces/:p/databases/:p/sources/:p` (internal) |
| `delete_space` | unreachable | `DELETE /workspaces/:p/spaces/:p` (unreach:scope_admin) |
| `delete_space_group` | unreachable | `DELETE /workspaces/:p/space-groups/:p` (unreach:scope_admin) |
| `delete_space_view` | internal | `DELETE /workspaces/:p/views/:p` (internal) |
| `delete_view` | unreachable | `DELETE /workspaces/:p/databases/:p/views/:p` (unreach:scope_admin) |
| `delete_webhook` | unreachable | `DELETE /workspaces/:p/webhooks/:p` (unreach:scope_admin); `GET /workspaces/:p/databases/:p/automations` (unreach:scope_admin); `GET /workspaces/:p/databases/:p/automations/:p/runs` (unreach:scope_admin) |
| `describe_database` | internal | `GET /workspaces/:p/databases/:p` (internal) |
| `discover_source_fields` | unreachable | `POST /workspaces/:p/databases/:p/sources/discover` (unreach:no_run_credential) |
| `duplicate_database` | internal | `POST /workspaces/:p/databases/:p/duplicate` (internal) |
| `duplicate_record` | gated | `POST /workspaces/:p/databases/:p/records/:p/duplicate` (gated) |
| `duplicate_view` | unreachable | `POST /workspaces/:p/databases/:p/views/:p/duplicate` (unreach:scope_admin) |
| `enqueue_bulk_record_job` | gated | `POST /workspaces/:p/databases/:p/records/batch-jobs` (gated) |
| `export_pack` | unreachable | `POST /workspaces/:p/packs/export` (unreach:scope_admin) |
| `export_skill` | internal | `GET /workspaces/:p/skills/:p/export` (internal) |
| `find_select_drift` | internal | `GET /workspaces/:p/relations/:p/select-drift` (internal) |
| `find_workflow_candidates` | internal | `GET /workspaces/:p/workflow-nomination` (internal) |
| `fix_select_drift` | gated | `POST /workspaces/:p/relations/:p/select-drift/reconcile` (gated) |
| `get_activity_event` | unreachable | `GET /workspaces/:p/activity-events/:p` (unreach:scope_admin) |
| `get_agent_wake_summary` | internal | `GET /workspaces/:p/agent-wakes/summary` (internal) |
| `get_agents` | unreachable | `GET /workspaces/:p/agents` (unreach:scope_admin) |
| `get_automation` | local | helper |
| `get_automation_last_payload` | internal | `GET /workspaces/:p/databases/:p/automations/:p/last-payload` (internal) |
| `get_bulk_record_job` | internal | `GET /workspaces/:p/databases/:p/records/batch-jobs/:p` (internal) |
| `get_credential` | unreachable | `GET /workspaces/:p/credentials/:p` (unreach:scope_admin) |
| `get_dismissed_hints` | internal | `GET /workspaces/:p/dismissed-hints` (internal) |
| `get_document` | internal | `GET /workspaces/:p/documents/:p` (internal) |
| `get_field_usage` | unreachable | `GET /workspaces/:p/databases/:p/fields/:p/usage` (unreach:scope_admin) |
| `get_history` | internal | `GET /workspaces/:p/databases/:p/records/:p/versions` (internal); `GET /workspaces/:p/databases/:p/records/:p/activity` (internal); `GET /workspaces/:p/databases/:p/records/:p/document/versions` (internal); `GET /workspaces/:p/databases/:p/records/:p/versions/changes` (internal) |
| `get_links` | internal | `GET /workspaces/:p/databases/:p/records/:p` (internal); `GET /workspaces/:p/spaces/:p/documents` (internal) |
| `get_my_work` | internal | `GET /workspaces/:p/favorites` (internal); `GET /workspaces/:p/recent` (internal); `GET /workspaces/:p/my-work` (internal) |
| `get_or_create_personal_space` | internal | `POST /workspaces/:p/spaces/personal` (internal) |
| `get_personal_collection_filter` | internal | `GET /workspaces/:p/databases/:p/fields/:p/personal-collection-view` (internal) |
| `get_personal_filter` | internal | `GET /workspaces/:p/databases/:p/views/:p/personal-filter` (internal) |
| `get_pinned_tabs` | internal | `GET /workspaces/:p/databases/:p/pinned-tabs` (internal) |
| `get_record` | internal | `GET /workspaces/:p/databases/:p/records/by-number/:p` (internal); `GET /workspaces/:p/databases/:p/records/:p` (internal); `GET /workspaces/:p/databases/:p` (internal) |
| `get_record_description` | internal | `GET /workspaces/:p/databases/:p/records/:p/document` (internal) |
| `get_relation` | unreachable | `GET /workspaces/:p/relations/:p` (unreach:scope_admin) |
| `get_run` | internal | `GET /workspaces/:p/runs/:p` (internal) |
| `get_run_quota` | internal | `GET /workspaces/:p/runs/quota` (internal) |
| `get_runs` | internal | `GET /workspaces/:p/runs` (internal) |
| `get_skill` | internal | `GET /workspaces/:p/skills/:p` (internal) |
| `get_staged_action` | unreachable | `GET /workspaces/:p/agents/runs/:p/staged` (unreach:scope_admin) |
| `get_started` | local | helper |
| `get_unread_count` | internal | `GET /workspaces/:p/notifications/unread-count` (internal) |
| `get_validation_rule_violations` | unreachable | `GET /workspaces/:p/databases/:p/validation-rules/:p/violations` (unreach:scope_admin) |
| `get_view` | internal | `GET /workspaces/:p/views/:p` (internal) |
| `get_workspace` | internal | `GET /workspaces/:p` (internal) |
| `import_skill` | gated | `POST /workspaces/:p/skills/import` (gated) |
| `install_pack` | unreachable | `GET /packs/registry/:p` (internal); `POST /workspaces/:p/packs/preview` (unreach:scope_admin); `POST /workspaces/:p/packs/install` (unreach:scope_admin) |
| `link_records` | gated | `PUT /workspaces/:p/databases/:p/records/:p/links/:p` (gated); `POST /workspaces/:p/databases/:p/records/:p/links/:p` (gated) |
| `list_action_gates` | unreachable | `GET /workspaces/:p/action-gates` (unreach:scope_admin) |
| `list_agent_activity` | unreachable | `GET /workspaces/:p/agents/:p/activity` (unreach:scope_admin) |
| `list_agent_wakes` | internal | `GET /workspaces/:p/agent-wakes` (internal) |
| `list_agent_write_gates` | internal | `GET /workspaces/:p/agent-write-gates` (internal) |
| `list_ai_connections` | internal | `GET /me/ai-connections` (internal) |
| `list_approvals` | internal | `GET /workspaces/:p/approvals` (internal); `GET /workspaces/:p/approvals/count` (internal) |
| `list_attachments` | internal | `GET /workspaces/:p/databases/:p/records/:p/attachments` (internal) |
| `list_audit_log` | unreachable | `GET /workspaces/:p/audit-log` (unreach:scope_admin) |
| `list_automations` | unreachable | `GET /workspaces/:p/databases/:p/automations` (unreach:scope_admin) |
| `list_backlinks` | internal | `GET /workspaces/:p/databases/:p/records/:p/backlinks` (internal) |
| `list_comments` | internal | `GET /workspaces/:p/databases/:p/records/:p/comments` (internal) |
| `list_connection_providers` | internal | `GET /workspaces/:p/connections/providers` (internal) |
| `list_connections` | internal | `GET /workspaces/:p/connections` (internal) |
| `list_credential_actions` | unreachable | `GET /workspaces/:p/credentials/:p/actions` (unreach:scope_admin) |
| `list_database_comments` | internal | `GET /workspaces/:p/databases/:p/activity/comments` (internal) |
| `list_databases` | local | helper |
| `list_databases_trash` | unreachable | `GET /workspaces/:p/databases/trash` (unreach:scope_admin) |
| `list_documents` | internal | `GET /workspaces/:p/spaces/:p/documents` (internal) |
| `list_folders` | unreachable | `GET /workspaces/:p/spaces/:p/folders` (unreach:scope_admin) |
| `list_grants` | unreachable | `GET /workspaces/:p/grants` (unreach:scope_admin) |
| `list_hierarchy_activity` | internal | `GET /workspaces/:p/databases/:p/records/:p/activity/hierarchy` (internal) |
| `list_icon_set` | local | helper |
| `list_installed_packs` | unreachable | `GET /workspaces/:p/packs/installed` (unreach:scope_admin) |
| `list_invites` | unreachable | `GET /workspaces/:p/invites` (unreach:scope_admin) |
| `list_linked_records` | internal | `GET /workspaces/:p/databases/:p/records/:p/links/:p` (internal) |
| `list_members` | internal | `GET /workspaces/:p/members` (internal) |
| `list_notifications` | internal | `GET /workspaces/:p/notifications` (internal) |
| `list_pack_submissions` | unreachable | `GET /workspaces/:p/packs/submissions` (unreach:scope_admin) |
| `list_packs` | internal | `GET /packs/registry` (internal) |
| `list_personal_views` | internal | `GET /workspaces/:p/views/personal` (internal) |
| `list_portal_activity` | unreachable | `GET /workspaces/:p/portal-activity` (unreach:scope_admin) |
| `list_portal_recipients` | unreachable | `GET /workspaces/:p/portal-recipients` (unreach:scope_admin) |
| `list_records` | internal | `GET /workspaces/:p/databases/:p/records` (internal) |
| `list_relations` | unreachable | `GET /workspaces/:p/relations` (unreach:scope_admin) |
| `list_runners` | internal | `GET /workspaces/:p/runners` (internal) |
| `list_skill_templates` | internal | `GET /workspaces/:p/skills/templates` (internal) |
| `list_skills` | local | helper |
| `list_source_providers` | internal | `GET /workspaces/:p/databases/:p/sources/providers` (internal) |
| `list_source_runs` | internal | `GET /workspaces/:p/databases/:p/sources/:p/runs` (internal); `GET /workspaces/:p/webhooks` (unreach:scope_admin) |
| `list_sources` | internal | `GET /workspaces/:p/databases/:p/sources` (internal) |
| `list_space_groups` | unreachable | `GET /workspaces/:p/space-groups` (unreach:scope_admin) |
| `list_space_views` | internal | `GET /workspaces/:p/spaces/:p/views` (internal) |
| `list_spaces` | internal | `GET /workspaces/:p/spaces` (internal) |
| `list_spaces_trash` | unreachable | `GET /workspaces/:p/spaces/trash` (unreach:scope_admin) |
| `list_templates` | internal | `GET /templates` (internal) |
| `list_trash` | internal | `GET /workspaces/:p/databases/:p/records/trash` (internal) |
| `list_validation_rules` | unreachable | `GET /workspaces/:p/databases/:p/validation-rules` (unreach:scope_admin) |
| `list_views_trash` | unreachable | `GET /workspaces/:p/databases/:p/views/trash` (unreach:scope_admin) |
| `list_watchers` | internal | `GET /workspaces/:p/databases/:p/records/:p/watchers` (internal) |
| `list_webhook_deliveries` | unreachable | `GET /workspaces/:p/webhooks/:p/deliveries` (unreach:scope_admin) |
| `list_webhooks` | unreachable | `GET /workspaces/:p/webhooks` (unreach:scope_admin) |
| `list_workspaces` | local | helper |
| `list_youtube_channels` | internal | `GET /workspaces/:p/databases/:p/sources/channels` (internal) |
| `mark_notifications` | internal | `POST /workspaces/:p/notifications/read-all` (internal); `POST /workspaces/:p/notifications/:p/read` (internal); `POST /workspaces/:p/notifications/:p/archive` (internal); `POST /workspaces/:p/notifications/:p/unarchive` (internal) |
| `move_document_to_space` | gated | `POST /workspaces/:p/documents/:p/move` (gated) |
| `move_record` | gated | `POST /workspaces/:p/databases/:p/records/:p/move` (gated) |
| `nominate_workflows` | unreachable | `POST /workspaces/:p/workflow-nomination` (unreach:scope_admin) |
| `propose_schema` | unreachable | `POST /workspaces/:p/architect/propose` (unreach:scope_admin) |
| `publish_view` | unreachable | `POST /workspaces/:p/databases/:p/views/:p/publish` (unreach:scope_admin) |
| `query_records` | internal | `POST /workspaces/:p/databases/:p/records/query` (internal) |
| `remove_sample_data` | internal | `DELETE /workspaces/:p/templates/sample-data` (internal) |
| `reorder_fields` | local | helper |
| `reorder_options` | unreachable | `POST /workspaces/:p/databases/:p/fields/:p/options/reorder` (unreach:scope_admin) |
| `reorder_views` | local | helper |
| `rerun_action` | unreachable | `POST /workspaces/:p/runs/:p/actions/:p/rerun` (unreach:no_run_credential) |
| `rerun_run` | unreachable | `POST /workspaces/:p/runs/:p/rerun` (unreach:no_run_credential) |
| `restore_database` | unreachable | `POST /workspaces/:p/databases/:p/restore` (unreach:scope_admin) |
| `restore_document_version` | gated | `POST /workspaces/:p/databases/:p/records/:p/document/versions/:p/restore` (gated) |
| `restore_records` | gated | `POST /workspaces/:p/databases/:p/records/:p/restore` (gated); `POST /workspaces/:p/databases/:p/records/batch-restore` (gated) |
| `restore_space` | unreachable | `POST /workspaces/:p/spaces/:p/restore` (unreach:scope_admin) |
| `restore_version` | gated | `POST /workspaces/:p/databases/:p/records/:p/versions/:p/restore` (gated) |
| `restore_view` | unreachable | `POST /workspaces/:p/databases/:p/views/:p/restore` (unreach:scope_admin) |
| `revoke_portal_recipient` | unreachable | `POST /workspaces/:p/portal-recipients/:p/revoke` (unreach:scope_admin) |
| `rotate_portal_recipient` | unreachable | `POST /workspaces/:p/portal-recipients/:p/rotate` (unreach:scope_admin) |
| `run_agent` | unreachable | `POST /workspaces/:p/agents/:p/run` (unreach:scope_admin) |
| `run_auto_link` | unreachable | `POST /workspaces/:p/relations/:p/auto-link` (unreach:scope_admin) |
| `run_button` | unreachable | `POST /workspaces/:p/databases/:p/records/:p/buttons/:p/press` (unreach:run_button_flag); `GET /workspaces/:p/spaces` (internal) |
| `run_skill` | internal | `POST /workspaces/:p/skills/:p/run` (internal) |
| `search` | internal | `GET /workspaces/:p/search` (internal) |
| `set_auto_link` | unreachable | `PATCH /workspaces/:p/relations/:p` (unreach:scope_admin) |
| `set_default_view` | unreachable | `POST /workspaces/:p/databases/:p/views/:p/default` (unreach:scope_admin) |
| `set_dismissed_hints` | internal | `DELETE /workspaces/:p/dismissed-hints` (internal); `PUT /workspaces/:p/dismissed-hints` (internal) |
| `set_favorite` | internal | `POST /workspaces/:p/favorites` (internal); `DELETE /workspaces/:p/favorites/:p/:p` (internal) |
| `set_personal_collection_filter` | internal | `DELETE /workspaces/:p/databases/:p/fields/:p/personal-collection-view` (internal); `GET /workspaces/:p/databases/:p/fields/:p/personal-collection-view` (internal); `PUT /workspaces/:p/databases/:p/fields/:p/personal-collection-view` (internal) |
| `set_personal_filter` | internal | `DELETE /workspaces/:p/databases/:p/views/:p/personal-filter` (internal); `PUT /workspaces/:p/databases/:p/views/:p/personal-filter` (internal) |
| `set_pinned_tabs` | internal | `DELETE /workspaces/:p/databases/:p/pinned-tabs` (internal); `PUT /workspaces/:p/databases/:p/pinned-tabs` (internal) |
| `setup_agents` | unreachable | `POST /workspaces/:p/agents/ensure` (unreach:scope_admin) |
| `share_view` | unreachable | `POST /workspaces/:p/databases/:p/views/:p/share` (unreach:scope_admin) |
| `sync_source` | unreachable | `POST /workspaces/:p/databases/:p/sources/:p/sync-now` (unreach:no_run_credential) |
| `test_automation` | unreachable | `POST /workspaces/:p/databases/:p/automations/:p/test` (unreach:scope_admin) |
| `undo_batch_update` | gated | `POST /workspaces/:p/databases/:p/records/batch-update-undo` (gated) |
| `uninstall_pack` | unreachable | `POST /workspaces/:p/packs/:p/uninstall` (unreach:scope_admin) |
| `unlink_records` | gated | `DELETE /workspaces/:p/databases/:p/records/:p/links/:p` (gated) |
| `unshare_view` | unreachable | `DELETE /workspaces/:p/databases/:p/views/:p/share` (unreach:scope_admin) |
| `update_automation` | unreachable | `PATCH /workspaces/:p/databases/:p/automations/:p` (unreach:scope_admin) |
| `update_comment` | gated | `PATCH /workspaces/:p/databases/:p/records/:p/comments/:p` (gated) |
| `update_database` | unreachable | `PATCH /workspaces/:p/databases/:p` (unreach:scope_admin) |
| `update_document` | gated | `GET /workspaces/:p/documents/:p` (internal); `PATCH /workspaces/:p/documents/:p` (gated) |
| `update_field` | unreachable | `PATCH /workspaces/:p/databases/:p/fields/:p` (unreach:scope_admin); `POST /workspaces/:p/databases/:p/fields/:p/options` (unreach:scope_admin); `PATCH /workspaces/:p/databases/:p/fields/:p/options/:p` (unreach:scope_admin); `DELETE /workspaces/:p/databases/:p/fields/:p/options/:p` (unreach:scope_admin) |
| `update_folder` | unreachable | `PATCH /workspaces/:p/folders/:p` (unreach:scope_admin) |
| `update_record` | gated | `PATCH /workspaces/:p/databases/:p/records/:p` (gated) |
| `update_record_description` | gated | `GET /workspaces/:p/databases/:p/records/:p/document` (internal); `PUT /workspaces/:p/databases/:p/records/:p/document` (gated) |
| `update_records` | gated | `PATCH /workspaces/:p/databases/:p/records/batch` (gated) |
| `update_skill` | gated | `PATCH /workspaces/:p/skills/:p` (gated) |
| `update_source` | unreachable | `PATCH /workspaces/:p/databases/:p/sources/:p` (unreach:no_run_credential) |
| `update_space` | unreachable | `PATCH /workspaces/:p/spaces/:p` (unreach:scope_admin) |
| `update_space_group` | unreachable | `PATCH /workspaces/:p/space-groups/:p` (unreach:scope_admin) |
| `update_space_view` | internal | `POST /workspaces/:p/views/:p/move-to-space` (internal); `PATCH /workspaces/:p/views/:p` (internal) |
| `update_view` | unreachable | `PATCH /workspaces/:p/databases/:p/views/:p` (unreach:scope_admin) |
| `update_webhook` | unreachable | `PATCH /workspaces/:p/webhooks/:p` (unreach:scope_admin) |
| `update_workspace` | unreachable | `PATCH /workspaces/:p` (unreach:scope_admin) |
| `upsert_record` | gated | `POST /workspaces/:p/databases/:p/records/upsert` (gated) |
| `watch_record` | internal | `POST /workspaces/:p/databases/:p/records/:p/watch` (internal); `DELETE /workspaces/:p/databases/:p/records/:p/watch` (internal) |

## Appendix B: routes by verdict

Every route is in `apps/api/test/helpers/outward-audit.ts` (explicit entries) or derived from its guards. Counts at this commit: gated 30 (27 are record-write routes whose fan-out is staged or logged by origin, #1174), internal 124, public 23, self_guarded 12, unreachable:no_run_credential 20, unreachable:platform_admin_session 11, unreachable:run_button_flag 1, unreachable:runner_token_only 4, unreachable:scope_admin 147, unreachable:session_only 10.
