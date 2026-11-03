/**
 * #1135 — the OUTWARD-TOOL GATE AUDIT, as data (docs/architecture/runner-outward-tool-audit.md is the prose and the method).
 *
 * Question: with a RUN CREDENTIAL (the per-run agent token of #1132: `mn_pat_…`, `origin = 'agent'`, capped at `write`), can an agent
 * DO ANYTHING OUTWARD without a StoryOS approval? Outward = anything that leaves StoryOS or reaches people outside the agent's own
 * records. Every route of the LIVE route table is in exactly one of two places:
 *
 *  1. DERIVED (no entry here): `mechanismOf` reads the route's own decorators and guards. These are the routes a run credential cannot
 *     reach, and the sweep proves each by a real request. A NEW route in this class needs nothing from you: the mechanism already
 *     refuses it. This is on purpose: the thing that decides is the guard, not a list.
 *  2. EXPLICIT (an entry below): everything the credential CAN reach, with a verdict and a reason. A NEW route that is neither derived
 *     nor listed FAILS run-credential-outward-sweep.test.ts, so a new outward-capable endpoint cannot ship unreviewed.
 *
 * Verdicts for an explicit entry:
 *  - internal      no effect outside StoryOS; a read returns data to the caller only.
 *  - gated         reaches an outward effect only through a staged approval (verified by a real request in the sweep).
 *                  A route that writes record data is `gated` through FANOUT_WHY (ticket #1174): the events it causes carry the agent's
 *                  origin, so every OUTWARD automation action is staged for a person, and the destinations an admin fixed (webhook
 *                  subscriptions, the Slack mention mirror, mention/watcher email to members, write-back opted out of approval) run as
 *                  configured and are LOGGED with the agent. run-credential-outward-staging.test.ts is the proof; the sweep checks the
 *                  `why` names it.
 *  - self_guarded  refused inside the handler (assertSession / assertPerson), which the sweep proves with a real request.
 *  - public        no AuthGuard: a run credential neither grants nor widens anything here.
 *
 * Finding F1 is closed (ticket #1174), so no entry says 'fanout' any more: an entry that named an open defect would outlive it
 * (CLAUDE.md: an assertion must not outlive its defect).
 */
export type ExplicitVerdict = 'internal' | 'gated' | 'self_guarded' | 'public';
export interface ExplicitEntry { verdict: ExplicitVerdict; why: string }

/** The audit's one finding (F1, ticket #1174), CLOSED: a record write's fan-out is staged or logged by its origin. */
export const FANOUT_PROOF = 'run-credential-outward-staging.test.ts';
export const FANOUT_WHY = `writes record data: the events that follow carry the agent origin (ticket #1174): outward automation actions are STAGED for approval, fixed destinations (outbound webhook subscriptions, Slack mention mirror, mention and watcher email to members, write-back opted out of approval) run as configured and are LOGGED with the agent. Proof: ${FANOUT_PROOF}`;

export type Mechanism = 'runner_token_only' | 'platform_admin_session' | 'session_only' | 'no_run_credential' | 'run_button_flag' | 'scope_admin';

/** What the route's own metadata says about a run credential. Null = the route is reachable and needs an explicit entry. */
export interface RouteMeta {
  guards: string[];
  sessionOnly: boolean;
  noRunCredential: boolean;
  runButton: boolean;
  /** `requiredTokenScope(...)` for the route: an explicit @RequiresScope wins, else @MinRole('admin') means admin, else GET read / write. */
  requiredScope: 'read' | 'write' | 'admin';
}

export function mechanismOf(m: RouteMeta): Mechanism | null {
  if (m.guards.includes('RunnerAuthGuard')) return 'runner_token_only'; // runner-auth.guard.ts: only an mn_run_ token; the global AuthGuard names it too
  if (m.guards.includes('PlatformAdminGuard')) return 'platform_admin_session'; // platform-admin.guard.ts: session only
  if (!m.guards.includes('AuthGuard')) return null;
  if (m.sessionOnly) return 'session_only'; // auth.guard.ts enforceTokenScope: SESSION_ONLY_KEY
  if (m.noRunCredential) return 'no_run_credential'; // auth.guard.ts: NO_RUN_CREDENTIAL_KEY, #1135
  // The run credential is minted with allowRunButton = false (run-credentials.service.ts), so a RunButtonRoute is refused (auth.guard.ts).
  if (m.runButton) return 'run_button_flag';
  // RUN_CREDENTIAL_SCOPE_CAP = 'write' (run-credentials.service.ts): a route that needs admin scope is above the cap.
  if (m.requiredScope === 'admin') return 'scope_admin';
  return null;
}

/** Keyed `METHOD /path` exactly as the controllers register it (no /api/v1 prefix). */
export const EXPLICIT: Record<string, ExplicitEntry> = {
  'GET /': { verdict: 'public', why: 'liveness / build info' },
  'GET /build-info': { verdict: 'public', why: 'liveness / build info' },
  'GET /healthz': { verdict: 'public', why: 'liveness' },
  'GET /api/docs': { verdict: 'public', why: 'static API docs page' },
  'GET /me': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /auth/providers': { verdict: 'public', why: 'public auth-provider list' },
  'GET /oauth/consent': { verdict: 'self_guarded', why: 'consent is a person approving a client: session only' },
  'POST /oauth/consent': { verdict: 'self_guarded', why: 'consent is a person approving a client: session only' },
  'GET /workspaces': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/spaces': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/spaces/personal': { verdict: 'internal', why: 'creates the owner\'s own personal space (private, ADR personal-space.md)' },
  'GET /workspaces/:ws/members': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/onboarding': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /me/ai-connections': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'DELETE /me/ai-connections/:id': { verdict: 'self_guarded', why: 'assertSession: only a signed-in session may disconnect an AI connection' },
  'POST /billing/webhook': { verdict: 'public', why: 'inbound Stripe webhook, verified by signature' },
  'GET /workspaces/:ws/agent-write-gates': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/fields/:field/personal-collection-view': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'PUT /workspaces/:ws/databases/:db/fields/:field/personal-collection-view': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'DELETE /workspaces/:ws/databases/:db/fields/:field/personal-collection-view': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/workflow-nomination': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records': { verdict: 'gated', why: FANOUT_WHY },
  'POST /workspaces/:ws/databases/:db/records/upsert': { verdict: 'gated', why: FANOUT_WHY },
  'POST /workspaces/:ws/databases/:db/records/query': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/databases/:db/records/aggregate': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/databases/:db/records/aggregate/grouped': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/databases/:db/records/batch': { verdict: 'gated', why: FANOUT_WHY },
  'PATCH /workspaces/:ws/databases/:db/records/batch': { verdict: 'gated', why: FANOUT_WHY },
  'POST /workspaces/:ws/databases/:db/records/batch-update-undo': { verdict: 'gated', why: FANOUT_WHY },
  'POST /workspaces/:ws/databases/:db/records/batch-jobs': { verdict: 'gated', why: FANOUT_WHY },
  'GET /workspaces/:ws/databases/:db/records/batch-jobs/:id': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/batch-delete': { verdict: 'gated', why: FANOUT_WHY },
  'POST /workspaces/:ws/databases/:db/records/batch-restore': { verdict: 'gated', why: FANOUT_WHY },
  'GET /workspaces/:ws/databases/:db/records/trash': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/by-number/:number': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'PATCH /workspaces/:ws/databases/:db/records/:rec': { verdict: 'gated', why: FANOUT_WHY },
  'DELETE /workspaces/:ws/databases/:db/records/:rec': { verdict: 'gated', why: FANOUT_WHY },
  'POST /workspaces/:ws/databases/:db/records/:rec/duplicate': { verdict: 'gated', why: FANOUT_WHY },
  'POST /workspaces/:ws/databases/:db/records/:rec/watch': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/watch': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/databases/:db/records/:rec/watchers': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/:rec/move': { verdict: 'gated', why: FANOUT_WHY },
  'POST /workspaces/:ws/databases/:db/records/:rec/restore': { verdict: 'gated', why: FANOUT_WHY },
  'GET /workspaces/:ws/databases/:db/records/:rec/backlinks': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/notifications': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/notifications/unread-count': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/notifications/:id/read': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/notifications/read-all': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/notifications/:id/archive': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/notifications/:id/unarchive': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /users/:id/avatar': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /users/me/preferences': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/attachments': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/:rec/attachments': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/databases/:db/records/:rec/attachments/:att/download': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/attachments/:att/thumbnail': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/attachments/:att': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/relations/:rel/select-drift': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/relations/:rel/select-drift/reconcile': { verdict: 'gated', why: FANOUT_WHY },
  'GET /workspaces/:ws/databases/:db/records/:rec/links/:field': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/:rec/links/:field': { verdict: 'gated', why: FANOUT_WHY },
  'PUT /workspaces/:ws/databases/:db/records/:rec/links/:field': { verdict: 'gated', why: FANOUT_WHY },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/links/:field': { verdict: 'gated', why: FANOUT_WHY },
  'GET /workspaces/:ws/databases/:db/automations/:id/last-payload': { verdict: 'internal', why: 'reads the last payload a hook received; the hook token itself is not returned here' },
  'POST /hooks/:workspaceSlug/:hookToken': { verdict: 'public', why: 'inbound webhook receiver: the hook token (+ HMAC secret) is the credential, so a run credential adds nothing; the only way to learn a token is regenerate-hook, which a run credential is refused' },
  'GET /workspaces/:ws/approvals': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/approvals/count': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/comments': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/:rec/comments': { verdict: 'gated', why: FANOUT_WHY },
  'PATCH /workspaces/:ws/databases/:db/records/:rec/comments/:comment': { verdict: 'gated', why: FANOUT_WHY },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/comments/:comment': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/databases/:db/records/:rec/activity': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/activity/hierarchy': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/activity/comments': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/versions': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/versions/changes': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/versions/:version': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/:rec/versions/:version/restore': { verdict: 'gated', why: FANOUT_WHY },
  'GET /workspaces/:ws/integrations': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/integrations/github/reviews': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/integrations/github/reviews/:owner/:repo/:number': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/integrations/github/reviews/:owner/:repo/:number/comments': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/integrations/github/reviews/:owner/:repo/:number/comments/sync': { verdict: 'internal', why: 'reads review comments FROM GitHub into the local cache with the workspace credential; the four routes that WRITE to GitHub are @NoRunCredential' },
  'POST /integrations/github/webhook': { verdict: 'public', why: 'inbound GitHub webhook, verified by signature' },
  'GET /integrations/github/oauth/callback': { verdict: 'public', why: 'OAuth callback, bound to a signed state' },
  'POST /workspaces/:ws/integrations/shopify/catalogue': { verdict: 'internal', why: 'creates databases, relations and Shopify SOURCES with config {} (write_back off), so the only third-party call is a read with the workspace connection (SourcesService.create in shopify-catalogue.service.ts:155-166); nothing is pushed' },
  'POST /providers/shopify/webhook/:connectionId': { verdict: 'public', why: 'inbound Shopify webhook, verified by HMAC' },
  'GET /workspaces/:ws/databases/:db/records/:rec/document': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'PUT /workspaces/:ws/databases/:db/records/:rec/document': { verdict: 'gated', why: FANOUT_WHY },
  'GET /workspaces/:ws/databases/:db/records/:rec/document/versions': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/document/versions/:version': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/:rec/document/versions/:version/restore': { verdict: 'gated', why: FANOUT_WHY },
  'GET /workspaces/:ws/spaces/:space/documents': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/spaces/:space/documents': { verdict: 'gated', why: FANOUT_WHY },
  'GET /workspaces/:ws/documents/:doc': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/documents/:doc/export/markdown': { verdict: 'internal', why: 'reviewed: renders one document as Markdown and returns it to the caller' },
  'GET /workspaces/:ws/documents/:doc/export/pdf': { verdict: 'internal', why: 'reviewed: renders one document and returns the PDF to the caller; the only network hop is the operator\'s own Gotenberg sidecar (env-configured, the caller cannot choose the URL)' },
  'PATCH /workspaces/:ws/documents/:doc': { verdict: 'gated', why: FANOUT_WHY },
  'DELETE /workspaces/:ws/documents/:doc': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/documents/:doc/move': { verdict: 'gated', why: FANOUT_WHY },
  'POST /workspaces/:ws/documents/:doc/copy-to-personal': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/connections': { verdict: 'internal', why: 'connections list never returns auth material (connections.service.ts present)' },
  'GET /workspaces/:ws/connections/providers': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /connections/oauth/callback': { verdict: 'public', why: 'OAuth callback, bound to a signed state' },
  'POST /providers/resend/webhook/:connectionId': { verdict: 'public', why: 'inbound Resend/Svix webhook, verified by signature' },
  'GET /workspaces/:ws/databases/:db/sources': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/sources/providers': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/sources/channels': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'DELETE /workspaces/:ws/databases/:db/sources/:id': { verdict: 'internal', why: 'deleting a source stops syncing and leaves its records (sources.service.ts remove)' },
  'GET /workspaces/:ws/databases/:db/sources/:id/runs': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/skills': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/skills/templates': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/skills/:id': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/skills': { verdict: 'gated', why: 'a non-human author asking for visibility public gets a PERSONAL skill plus an approval a person decides (skills.service.ts assertMayPublish, skill-publish-gate.service.ts); every other visibility stays inside the workspace' },
  'POST /workspaces/:ws/skills/import': { verdict: 'gated', why: 'a non-human author asking for visibility public gets a PERSONAL skill plus an approval a person decides (skills.service.ts assertMayPublish, skill-publish-gate.service.ts); every other visibility stays inside the workspace' },
  'PATCH /workspaces/:ws/skills/:id': { verdict: 'gated', why: 'a non-human author asking for visibility public gets a PERSONAL skill plus an approval a person decides (skills.service.ts assertMayPublish, skill-publish-gate.service.ts); every other visibility stays inside the workspace' },
  'DELETE /workspaces/:ws/skills/:id': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/skills/:id/export': { verdict: 'internal', why: 'reviewed: returns one skill as Markdown to the caller' },
  'POST /workspaces/:ws/skills/:id/run': { verdict: 'internal', why: 'returns a step log, no model is invoked (skills.service.ts run)' },
  'GET /public/skills/:token': { verdict: 'public', why: 'public skill link (read)' },
  'POST /workspaces/:ws/databases/:db/views/personal': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/databases/:db/views/:view/copy-to-personal': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/databases/:db/views/:view/personal-filter': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'PUT /workspaces/:ws/databases/:db/views/:view/personal-filter': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'DELETE /workspaces/:ws/databases/:db/views/:view/personal-filter': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/databases/:db/pinned-tabs': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'PUT /workspaces/:ws/databases/:db/pinned-tabs': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'DELETE /workspaces/:ws/databases/:db/pinned-tabs': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/dismissed-hints': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'PUT /workspaces/:ws/dismissed-hints': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'DELETE /workspaces/:ws/dismissed-hints': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/spaces/:space/views': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/spaces/:space/views': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/views/personal': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/views/:view': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/views/:view/move-to-space': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'PATCH /workspaces/:ws/views/:view': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'DELETE /workspaces/:ws/views/:view': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /public/views/:token': { verdict: 'public', why: 'public view link (read)' },
  'GET /workspaces/:ws/databases/:db/export/csv': { verdict: 'internal', why: 'reviewed: returns one database as CSV to the caller (data the credential can already read; the whole-workspace .zip export is admin scope)' },
  'GET /capabilities': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /me/tokens': { verdict: 'self_guarded', why: 'assertSession (tokens.controller.ts): only a signed-in session may manage tokens' },
  'DELETE /me/tokens/:token': { verdict: 'self_guarded', why: 'assertSession (tokens.controller.ts): only a signed-in session may manage tokens' },
  'POST /workspaces/:ws/files': { verdict: 'internal', why: 'stores a file; its capability URL is unauthenticated by design (#201) but only leaves StoryOS if another outward route carries it' },
  'POST /workspaces/:ws/files/:id/download-url': { verdict: 'internal', why: 'mints a signed, expiring URL for the caller; it leaves StoryOS only if another outward route carries it' },
  'GET /files/:id': { verdict: 'public', why: 'capability-URL file serve (read)' },
  'GET /files/:id/download': { verdict: 'public', why: 'signed download URL (read)' },
  'GET /workspaces/:ws/search': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/my-work': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/recent': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/import': { verdict: 'gated', why: FANOUT_WHY },
  'POST /workspaces/:ws/databases/:db/records/copy': { verdict: 'gated', why: FANOUT_WHY },
  'GET /workspaces/:ws/runs/quota': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/runs': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/runs/:id': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/runners/pairing-codes': { verdict: 'self_guarded', why: 'assertPerson (runners.controller.ts): session only, a Runner decides where an agent\'s work and data go' },
  'GET /workspaces/:ws/runners/pairing-codes/:id': { verdict: 'self_guarded', why: 'assertPerson (runners.controller.ts): session only, a Runner decides where an agent\'s work and data go' },
  'DELETE /workspaces/:ws/runners/pairing-codes/:id': { verdict: 'self_guarded', why: 'assertPerson (runners.controller.ts): session only, a Runner decides where an agent\'s work and data go' },
  'GET /workspaces/:ws/runners': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/runners/:id/activate': { verdict: 'self_guarded', why: 'assertPerson (runners.controller.ts): session only, a Runner decides where an agent\'s work and data go' },
  'PATCH /workspaces/:ws/runners/:id': { verdict: 'self_guarded', why: 'assertPerson (runners.controller.ts): session only, a Runner decides where an agent\'s work and data go' },
  'DELETE /workspaces/:ws/runners/:id': { verdict: 'self_guarded', why: 'assertPerson (runners.controller.ts): session only, a Runner decides where an agent\'s work and data go' },
  'GET /workspaces/:ws/runner-assignments/:agent': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'PUT /workspaces/:ws/runner-assignments/:agent': { verdict: 'self_guarded', why: 'assertPerson (runners.controller.ts): session only, a Runner decides where an agent\'s work and data go' },
  'POST /runner/v1/pair': { verdict: 'public', why: 'POST /runner/v1/pair is authenticated by the one-time pairing code, not by any token' },
  'GET /workspaces/:ws/agent-wakes': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/agent-wakes/summary': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /templates': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/templates/:slug/apply': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'DELETE /workspaces/:ws/templates/sample-data': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /packs/registry': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /packs/registry/:slug': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /public/packs/registry': { verdict: 'public', why: 'public pack registry (read)' },
  'GET /public/packs/registry/:slug': { verdict: 'public', why: 'public pack registry (read)' },
  'GET /packs/marketplace': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /packs/marketplace/:slug': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/duplicate': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/favorites': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/favorites': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'DELETE /workspaces/:ws/favorites/:type/:id': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /public/forms/:token': { verdict: 'public', why: 'public form: the form token is the credential; inbound only' },
  'POST /public/forms/:token': { verdict: 'public', why: 'public form: the form token is the credential; inbound only' },
  'GET /public/forms/:token/relations/:fieldId': { verdict: 'public', why: 'public form: the form token is the credential; inbound only' },
  'POST /public/forms/:token/relations/:fieldId': { verdict: 'public', why: 'public form: the form token is the credential; inbound only' },
};

/**
 * #1178 — the DELETE-capable routes a run credential CAN reach, and what happens to each when the agent's own `approval_policy` lists
 * `delete`. The set is read from the live route table by `isDeleteCapable` (every DELETE route, plus any route whose path or handler
 * says delete/remove/purge/unlink), and every member is in exactly ONE place:
 *
 *  - derived-unreachable: the route's guards refuse a run credential (admin scope, session only, no_run_credential, ...). Proven by
 *    the sweep's own real requests; nothing to list here.
 *  - HELD_DELETE_ROUTES: the credential can reach it and, with the policy, the call is STAGED for a person (202 pending_approval).
 *    The handler carries `@HoldsAgentDeletes(kind)` (action-gates/agent-delete-route.ts); run-credential-delete-policy.test.ts calls
 *    every entry with a real credential and fails when an entry has no fixture.
 *  - OWN_STATE_DELETE_ROUTES: it clears the member's OWN view or preference (a pin, a personal filter, a favourite, a watch), or is
 *    refused inside the handler for a credential. Nothing shared is lost, so the policy does not hold it. Each says why.
 *
 * A NEW delete-capable route that is none of these FAILS the sweep: it cannot ship with the policy silently not applying. The limit
 * of `isDeleteCapable` is its words: a route that deletes under a name without delete/remove/purge/unlink and is not a DELETE is not
 * found by it. The outward sweep's own classification of every route (above) still makes a human review that route once.
 */
export const HELD_DELETE_ROUTES: Record<string, { kind: string }> = {
  'DELETE /workspaces/:ws/databases/:db/records/:rec': { kind: 'record' },
  'POST /workspaces/:ws/databases/:db/records/batch-delete': { kind: 'record' },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/links/:field': { kind: 'link' },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/comments/:comment': { kind: 'comment' },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/attachments/:att': { kind: 'attachment' },
  'DELETE /workspaces/:ws/documents/:doc': { kind: 'document' },
  'DELETE /workspaces/:ws/databases/:db/sources/:id': { kind: 'source' },
  'DELETE /workspaces/:ws/skills/:id': { kind: 'skill' },
  'DELETE /workspaces/:ws/views/:view': { kind: 'space_view' },
  'DELETE /workspaces/:ws/templates/sample-data': { kind: 'sample_data' },
};

const OWN = "clears only the member's OWN preference or view state: nothing shared is lost, so the agent's delete policy does not hold it";
export const OWN_STATE_DELETE_ROUTES: Record<string, string> = {
  'DELETE /workspaces/:ws/databases/:db/records/:rec/watch': `${OWN} (a watch subscription)`,
  'DELETE /workspaces/:ws/databases/:db/fields/:field/personal-collection-view': `${OWN} (a personal collection view)`,
  'DELETE /workspaces/:ws/databases/:db/views/:view/personal-filter': `${OWN} (a personal filter)`,
  'DELETE /workspaces/:ws/databases/:db/pinned-tabs': `${OWN} (pinned tabs)`,
  'DELETE /workspaces/:ws/dismissed-hints': `${OWN} (dismissed hints)`,
  'DELETE /workspaces/:ws/favorites/:type/:id': `${OWN} (a favourite)`,
  'DELETE /me/ai-connections/:id': 'refused inside the handler for a credential (assertSession): only a signed-in session may disconnect an AI connection',
  'DELETE /me/tokens/:token': 'refused inside the handler for a credential (assertSession): only a signed-in session may manage tokens',
  'DELETE /workspaces/:ws/runners/pairing-codes/:id': 'refused inside the handler for a credential (assertPerson): session only',
  'DELETE /workspaces/:ws/runners/:id': 'refused inside the handler for a credential (assertPerson): session only',
};

/** The route table's own words for "this can delete": the DELETE method, or delete/remove/purge/unlink in the path or the handler name. */
export function isDeleteCapable(r: { method: string; path: string; handler: string }): boolean {
  return r.method === 'DELETE' || /delet|remov|purge|unlink/i.test(r.path) || /delet|remov|purge|unlink/i.test(r.handler);
}

/**
 * #1179 — the FAN-OUT CONSUMERS: code that reacts to a record write without a request of its own (a domain-event subscriber, or a
 * timer-driven sender), so the route table cannot see it. The sweep enumerates them from the SOURCE (every file under src/ that calls
 * `domainEvents.subscribe(` or `setInterval(`), so a consumer added tomorrow FAILS until it is classified here. Verdicts:
 *  - held     an agent-caused effect that can reach an outsider is staged for approval (proof named)
 *  - logged   the destination is fixed by an admin, so it runs as configured and is LOGGED with the agent (proof named)
 *  - none     reaches nothing outside StoryOS, or does not act on an agent's write at all (the reason says which)
 */
export type FanoutVerdict = 'held' | 'logged' | 'none';
export interface FanoutEntry { verdict: FanoutVerdict; why: string }
const P1174 = 'run-credential-outward-staging.test.ts';
const P1179 = 'run-credential-outward-part2.test.ts';
export const FANOUT_CONSUMERS: Record<string, FanoutEntry> = {
  'automations/automations.service.ts': { verdict: 'held', why: `outward automation actions are staged when an agent caused the event. Proof: ${P1174}` },
  'sources/write-back.subscriber.ts': { verdict: 'held', why: `a push on a source that opted in to approval is held; one that opted out is logged with the agent. Proof: ${P1174}` },
  'webhooks/webhooks.service.ts': { verdict: 'logged', why: `outbound webhook subscriptions are admin-fixed; the delivery carries caused_by. Proof: ${P1174}` },
  'calendar-sync/calendar-sync.service.ts': { verdict: 'logged', why: `the bound calendar is admin-fixed: logged as outward.calendar_sync; an event can never carry guests (assertNoInvitees tripwire). Proof: ${P1179}` },
  'integrations/linear-write-back.service.ts': { verdict: 'held', why: `an agent's comment is posted as the agent and logged; held when write_back.require_approval_for_agent_comments is on. Proof: ${P1179}` },
  'records/ai-field.subscriber.ts': { verdict: 'logged', why: `the workspace's own configured AI, not held; logged as outward.ai_field; the recompute emits no event, so no wake loop. Proof: ${P1179}` },
  'records/bulk-record-jobs.service.ts': { verdict: 'held', why: `a timer-run bulk write carries the stored origin, so the rules it fires are staged. Proof: ${P1174}` },
  'automations/job-runner.service.ts': { verdict: 'held', why: `makes the job payload's origin ambient around every executor. Proof: ${P1174}` },
  'agents/trigger.subscriber.ts': { verdict: 'none', why: 'wakes an agent run: an agent trigger is not outward; the run it starts stages its own actions' },
  'records/rollup-invalidation.subscriber.ts': { verdict: 'none', why: 'recomputes derived values inside StoryOS' },
  'relations/auto-link.subscriber.ts': { verdict: 'none', why: 'links records inside StoryOS' },
  'integrations/shopify-catalogue.subscriber.ts': { verdict: 'none', why: 'refreshes a local catalogue cache; no push to Shopify' },
  'workspaces/workspace-activation-events.service.ts': { verdict: 'none', why: 'internal activation bookkeeping; does not act on an agent write' },
  'workspaces/onboarding-nudge.service.ts': { verdict: 'none', why: 'a timer nudge to members, not caused by an agent write' },
  'integrations/github.service.ts': { verdict: 'none', why: 'inbound GitHub sync on a timer; not caused by an agent write' },
  'integrations/linear.service.ts': { verdict: 'none', why: 'inbound Linear import on a timer; writes only StoryOS records' },
  'sources/sources.service.ts': { verdict: 'none', why: 'inbound source sync on a timer; pushes are write-back.subscriber.ts' },
  'connections/connections.service.ts': { verdict: 'none', why: 'token refresh on a timer; not caused by an agent write' },
  'billing/auto-reload-retry.service.ts': { verdict: 'none', why: 'billing retry timer, not caused by an agent write' },
  'billing/trial-reminders.service.ts': { verdict: 'none', why: 'trial reminder timer, not caused by an agent write' },
  'runners/runner-sweeper.service.ts': { verdict: 'none', why: 'Runner liveness sweep' },
  'members/members-projection.subscriber.ts': { verdict: 'none', why: 'membership events, not record writes; projects into the Members database' },
};
