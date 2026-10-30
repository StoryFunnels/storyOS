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
 *  - fanout        OUTWARD AND UNGATED (a finding): it writes record data, and the events that follow reach admin-configured outward
 *                  actions with no approval. The `why` names the open ticket; the sweep fails if it does not.
 *  - self_guarded  refused inside the handler (assertSession / assertPerson), which the sweep proves with a real request.
 *  - public        no AuthGuard: a run credential neither grants nor widens anything here.
 *
 * A 'fanout' entry is NOT an assertion that the defect persists (CLAUDE.md: an assertion must not outlive its defect). When the ticket
 * lands, change the entry's verdict; nothing here pins the behaviour.
 */
export type ExplicitVerdict = 'internal' | 'gated' | 'fanout' | 'self_guarded' | 'public';
export interface ExplicitEntry { verdict: ExplicitVerdict; why: string }

/** The one open finding of the audit (see the ticket for the repro). */
export const FANOUT_TICKET = 'ticket #1174';

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
  'POST /workspaces/:ws/databases/:db/records': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'POST /workspaces/:ws/databases/:db/records/upsert': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'POST /workspaces/:ws/databases/:db/records/query': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/databases/:db/records/aggregate': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/databases/:db/records/aggregate/grouped': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/databases/:db/records/batch': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'PATCH /workspaces/:ws/databases/:db/records/batch': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'POST /workspaces/:ws/databases/:db/records/batch-update-undo': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'POST /workspaces/:ws/databases/:db/records/batch-jobs': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'GET /workspaces/:ws/databases/:db/records/batch-jobs/:id': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/batch-delete': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'POST /workspaces/:ws/databases/:db/records/batch-restore': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'GET /workspaces/:ws/databases/:db/records/trash': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/by-number/:number': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'PATCH /workspaces/:ws/databases/:db/records/:rec': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'DELETE /workspaces/:ws/databases/:db/records/:rec': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'POST /workspaces/:ws/databases/:db/records/:rec/duplicate': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'POST /workspaces/:ws/databases/:db/records/:rec/watch': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/watch': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/databases/:db/records/:rec/watchers': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/:rec/move': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'POST /workspaces/:ws/databases/:db/records/:rec/restore': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
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
  'POST /workspaces/:ws/relations/:rel/select-drift/reconcile': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'GET /workspaces/:ws/databases/:db/records/:rec/links/:field': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/:rec/links/:field': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'PUT /workspaces/:ws/databases/:db/records/:rec/links/:field': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/links/:field': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'GET /workspaces/:ws/databases/:db/automations/:id/last-payload': { verdict: 'internal', why: 'reads the last payload a hook received; the hook token itself is not returned here' },
  'POST /hooks/:workspaceSlug/:hookToken': { verdict: 'public', why: 'inbound webhook receiver: the hook token (+ HMAC secret) is the credential, so a run credential adds nothing; the only way to learn a token is regenerate-hook, which a run credential is refused' },
  'GET /workspaces/:ws/approvals': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/approvals/count': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/comments': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/:rec/comments': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'PATCH /workspaces/:ws/databases/:db/records/:rec/comments/:comment': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'DELETE /workspaces/:ws/databases/:db/records/:rec/comments/:comment': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'GET /workspaces/:ws/databases/:db/records/:rec/activity': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/activity/hierarchy': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/activity/comments': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/versions': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/versions/changes': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/versions/:version': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/:rec/versions/:version/restore': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
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
  'PUT /workspaces/:ws/databases/:db/records/:rec/document': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'GET /workspaces/:ws/databases/:db/records/:rec/document/versions': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/databases/:db/records/:rec/document/versions/:version': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/databases/:db/records/:rec/document/versions/:version/restore': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'GET /workspaces/:ws/spaces/:space/documents': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'POST /workspaces/:ws/spaces/:space/documents': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'GET /workspaces/:ws/documents/:doc': { verdict: 'internal', why: 'read: returns data to the caller only' },
  'GET /workspaces/:ws/documents/:doc/export/markdown': { verdict: 'internal', why: 'reviewed: renders one document as Markdown and returns it to the caller' },
  'GET /workspaces/:ws/documents/:doc/export/pdf': { verdict: 'internal', why: 'reviewed: renders one document and returns the PDF to the caller; the only network hop is the operator\'s own Gotenberg sidecar (env-configured, the caller cannot choose the URL)' },
  'PATCH /workspaces/:ws/documents/:doc': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'DELETE /workspaces/:ws/documents/:doc': { verdict: 'internal', why: 'changes StoryOS data the owner may already change; nothing leaves StoryOS' },
  'POST /workspaces/:ws/documents/:doc/move': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
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
  'POST /workspaces/:ws/databases/:db/import': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
  'POST /workspaces/:ws/databases/:db/records/copy': { verdict: 'fanout', why: 'writes record data: the resulting events reach admin-configured outward actions (automations, outbound webhooks, Slack mention mirror, watcher email, opted-in write-back) with no approval: ticket #1174' },
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
