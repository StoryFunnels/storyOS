/**
 * MCP ↔ API coverage (#397).
 *
 * The founder's principle: **"MCP should be able to do whatever API can."**
 * StoryOS is agent-first, so a capability that is not reachable over MCP
 * effectively does not exist for the product's main consumer.
 *
 * Four gaps surfaced in a single day, each found by a session getting stuck, and
 * nobody knew how many more there were. This file is the answer to "how big is
 * it": every REST operation is either **reached** by a tool (derived from the
 * source, so it cannot drift), **excluded** here with a reason, or **deferred**
 * here against a ticket. `coverage.test.ts` fails on anything that is none of
 * the three — so silence stops being a possible outcome.
 *
 * Note what this is NOT: an argument for one tool per endpoint. A good MCP tool
 * is often coarser than a REST call — `create_record` doing label resolution and
 * markdown parsing is worth more than a thin passthrough. The requirement is
 * that every CAPABILITY is reachable, not that the two surfaces mirror each
 * other operation for operation.
 */

export interface CoverageRule {
  /** Matched against `METHOD /path` — a prefix, or a regex for finer cuts. */
  match: string | RegExp;
  /** Why. A rule with a weak reason is a gap wearing a disguise. */
  reason: string;
}

/**
 * Deliberately unreachable over MCP.
 *
 * Every entry answers "why would an agent never need this, or why must it never
 * have it". "Nobody asked for it" is not a reason and does not appear here.
 */
export const EXCLUDED: CoverageRule[] = [
  {
    match: /^POST \/api\/v1\/(hooks|billing\/webhook|providers\/\w+\/webhook|integrations\/github\/webhook)/,
    reason:
      'Inbound receiver, unauthenticated by design and signature-verified. Something calls US here; there is nothing for an agent to invoke.',
  },
  {
    match: /^GET \/api\/v1\/(connections\/oauth\/callback|integrations\/github\/oauth\/callback)/,
    reason: 'OAuth redirect target. Only a browser mid-handshake can meaningfully call it.',
  },
  {
    match: '/api/v1/admin/',
    reason:
      'Platform-operator surface spanning every workspace on the instance. A workspace-scoped agent token has no business reaching across tenants, and the endpoints are gated on a platform admin rather than a workspace role.',
  },
  {
    match: /\/api\/v1\/(workspaces\/\{ws\}\/)?billing/,
    reason:
      'Money. Checkout sessions, credit top-ups, auto-reload and plan changes are decisions a person makes with a card, not something an assistant should be able to trigger on their behalf.',
  },
  {
    match: /^(GET|POST|DELETE) \/api\/v1\/me\/tokens/,
    reason:
      'PRIVILEGE ESCALATION. A tool that mints personal access tokens would let an agent issue itself a fresh credential outliving its run, and the whole point of ADR-0016 §2 is a short-lived token revoked when the turn ends.',
  },
  {
    match: /^GET \/api\/v1\/me$/,
    reason:
      'The authenticated identity. `get_started` already tells a tool-caller who it is acting as and what its scope allows, written for a model rather than for a session-management UI.',
  },
  {
    match: '/api/v1/users/',
    reason:
      'Personal identity and preferences — avatars, per-user settings. Belongs to the human, not to work happening on their behalf.',
  },
  {
    match: '/api/v1/public/',
    reason:
      'Anonymous pre-auth surface (public form fill, pre-signup pack browsing). Reachable without a credential by design, so an authenticated tool adds nothing.',
  },
  {
    // Only the binary halves. `GET .../attachments` is the METADATA listing and
    // `list_attachments` calls it — excluding that too was an overreach the
    // contradiction check below caught.
    match: /(\/files|\/avatar|\/attachments\/\{att\}\/(download|thumbnail)|export\/csv|export\/workspace\.zip)|^POST \/api\/v1\/workspaces\/\{ws\}\/databases\/\{db\}\/records\/\{rec\}\/attachments$/,
    reason:
      'Binary or streaming payloads. MCP carries JSON text; a tool that returned a file stream or took a multipart upload would either not work or would inline megabytes into a model context. `list_attachments`/`attach_file` cover the metadata and upload-by-reference cases that are actually useful.',
  },
  {
    match: /^POST \/api\/v1\/workspaces\/\{ws\}\/databases\/\{db\}\/import$/,
    reason: 'Multipart CSV upload — same binary reasoning. `create_records` covers bulk creation from data an agent already holds.',
  },
  {
    match: '/api/v1/workspaces/{ws}/tyron/',
    reason:
      'Tyron is an MCP CLIENT of this server (ADR-0016), not a resource it exposes. A tool for driving Tyron would let an agent drive an agent that drives these same tools.',
  },
  {
    match: /\/(approvals\/\{id\}\/(approve|reject)|runs\/\{run\}\/(approve|reject))$/,
    reason:
      'HUMAN-ONLY BY DESIGN. ADR-0010 gates risky actions behind an approval an inbox surfaces to a person. An agent able to approve its own staged action does not defeat the gate partially — it removes it.',
  },
  {
    match: '/gdpr/',
    reason:
      'Irreversible erasure of a person\'s data, and an export of everything held about them. Both are decisions with legal weight that a human takes deliberately.',
  },
  {
    match: /\/api\/v1\/workspaces\/\{ws\}\/integrations(\/|$)/,
    reason:
      'Credential-bearing third-party configuration (Slack tokens, GitHub installations, Linear keys) and provider-specific surfaces such as submitting PR reviews. Storing or rotating someone else\'s credential, and speaking on their behalf on another platform, are separate trust decisions from working inside StoryOS.',
  },
  {
    match: '/api/v1/workspaces/{ws}/connections',
    reason:
      'Connection credentials — the same trust decision as integrations. `list_sources` already exposes what is connected, without the auth material.',
  },
  {
    match: /^GET (\/|\/healthz|\/api\/v1\/auth\/providers)$/,
    reason: 'Instance root, liveness probe and sign-in configuration. Infrastructure, not workspace capability.',
  },
  {
    match: '/api/v1/referrals',
    reason: 'Growth/referral attribution tied to a human account.',
  },
  {
    match: '/api/v1/workspaces/{ws}/onboarding',
    reason: 'Derived state for the UI\'s Getting-Started checklist. `get_started` is the MCP equivalent and is written for a model rather than a widget.',
  },
];

/**
 * Should be reachable, is not yet, and is tracked.
 *
 * The honest third category. #397 says "every gap is either closed or given an
 * explicit exclusion reason", and pretending a real gap is a deliberate
 * exclusion would be the exact silence this file exists to prevent — so these
 * carry a ticket instead of a justification.
 */
export const DEFERRED: CoverageRule[] = [
  /*
   * Every entry cites #406, and that is deliberate rather than lazy.
   *
   * The first draft of this file invented fourteen ticket numbers, one per
   * area — none of which existed. That is exactly the defect #390 documents: a
   * load-bearing rule pointing at unrelated ticket numbers is worse than no
   * rule, because the next reader trusts it. #406 is one real ticket whose body
   * carries the fourteen areas as sections; split it when an area is picked up.
   */
  {
    match: /\/records\/(trash|batch-delete|batch-restore|\{rec\}\/(restore|duplicate|move))/,
    reason:
      '#406 — record lifecycle: trash, restore, duplicate, reposition, and the batch delete/restore pair. `create_records`/`update_records` landed with #394; these are the rest of the same surface.',
  },
  {
    match: /^GET \/api\/v1\/workspaces\/\{ws\}\/databases\/\{db\}\/records$/,
    reason:
      '#406 — listing in MANUAL (drag) order. `query_records` covers filtering and field sorts but cannot return a board/list\'s hand-arranged order, so "the top five as the user arranged them" is unanswerable — which is also #392\'s gap seen from the read side.',
  },
  {
    match: /\/records\/\{rec\}\/(versions|activity|comments|watch|watchers|backlinks|links)/,
    reason:
      '#406 — everything hanging off a record other than its values: history, activity, comments, watchers, backlinks, relation chips. `add_comment` exists; reading them back does not.',
  },
  {
    match: /\/(views\/\{view\}|views\/\{view\}\/(personal-filter|duplicate|default)|spaces\/\{space\}\/views)/,
    reason:
      '#406 — view management beyond create/update/delete: duplicate, set-default, space-level views, and the per-viewer personal filter. #332 closed reading a view\'s config and querying through it.',
  },
  {
    match: /\/(sources|sources\/.*)$/,
    reason: '#406 — source (sync) configuration. `list_sources` is read-only; creating, reconfiguring and running a sync are not exposed.',
  },
  {
    match: '/api/v1/workspaces/{ws}/notifications',
    reason: '#406 — the inbox. An agent that can notify someone cannot see whether anything is waiting for the person it works for.',
  },
  {
    match: /\/(favorites|my-work|recent)/,
    reason: '#406 — the personal surfaces a person actually opens: starred items, my work, recently touched.',
  },
  {
    match: /\/(grants|members|invites)/,
    reason:
      '#406 — membership and access. Deliberately NOT excluded: reading who is in a workspace and what they can see is ordinary context. Writing it is a real decision and the ticket should split the two.',
  },
  {
    match: '/api/v1/workspaces/{ws}/skills',
    reason: '#406 — skill authoring. `list_skills`/`run_skill` exist, so an agent can run a skill but never write or edit one.',
  },
  {
    match: '/api/v1/workspaces/{ws}/webhooks',
    reason: '#406 — outbound webhook subscriptions and their delivery log.',
  },
  {
    match: /\/(documents|folders)/,
    reason: '#406 — standalone documents and sidebar folders.',
  },
  {
    match: '/api/v1/workspaces/{ws}/relations/',
    reason: '#406 — relation configuration beyond create/delete: auto-link rules, running auto-link, select↔relation drift.',
  },
  {
    match: /\/(templates|packs)/,
    reason:
      '#406 — the rest of the pack surface: installed packs, uninstall, export, marketplace and submissions, plus starter templates. #394 exposed the registry and install/preview.',
  },
  {
    match: /\/agents(\/|$)/,
    reason:
      '#406 — the agent engine: provisioning, running, delegating, triggers, staged runs. Note the approve/reject halves are EXCLUDED above and must stay so.',
  },
  {
    match: '/api/v1/workspaces/{ws}/runs',
    reason: '#406 — run history, quota and re-running a failed action.',
  },
  {
    match: /\/automations\/\{id\}\/(test|last-payload|regenerate-hook)/,
    reason: '#406 — automation dry-run, last received payload, and hook-token rotation. Rule CRUD is already covered.',
  },
  {
    match: /\/fields\/\{field\}\/usage$/,
    reason: '#406 — how many records carry a value for a field; the number you want before deleting one.',
  },
  {
    match: /^(GET|POST) \/api\/v1\/workspaces(\/\{ws\})?$/,
    reason:
      '#406 — reading one workspace\'s details and creating a workspace. `list_workspaces` covers the common case; creation is plan-gated and worth deciding deliberately.',
  },
  {
    match: /\/spaces\/\{space\}\/documents/,
    reason: '#406 — documents that live in a space rather than on a record.',
  },
];

/** `METHOD /path` for one operation. */
export const opKey = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

export function findRule(key: string, rules: CoverageRule[]): CoverageRule | undefined {
  return rules.find((r) => (typeof r.match === 'string' ? key.includes(r.match) : r.match.test(key)));
}
