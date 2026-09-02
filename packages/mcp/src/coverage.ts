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
    match: /(POST|DELETE|PATCH) .*\/(grants|invites|members)(\/|$)/,
    reason:
      /*
       * #441 — the write half of membership and access. EXCLUDED, not deferred,
       * with the split recorded on the ticket before any code (which is what
       * #406 asked for on this area specifically).
       *
       * ADR-0010's reasoning, unchanged: a token's SCOPE is what it may do, and
       * the GRANT SET is what it may do it to. An agent that can edit the
       * second collapses the distinction — it can widen its own blast radius,
       * and no approval gate sees it happen.
       *
       * There is also no compensating benefit. Inviting a colleague and handing
       * out database access are things a person does a handful of times,
       * deliberately, and are already two clicks in-app. Rare case where the
       * capability gap costs almost nothing and closing it costs a lot.
       *
       * Inviting is worse than re-granting and would stay out even if this were
       * reopened: POST /invites is the only route here that sends mail to an
       * address of the agent's choosing, i.e. to someone not yet in the
       * workspace at all.
       *
       * Same line #442 draws for publishing a shared skill and #446 for
       * submitting a pack. Three areas, one rule: an agent may prepare, a
       * person decides.
       */
      "#441 — an agent that can grant access can widen its own blast radius: scope is what a token MAY do, grants are what it may do it TO, and letting one edit the other removes the distinction (ADR-0010). Reading membership IS reachable (list_members); changing it is a human act.",
  },
  {
    match: 'POST /api/v1/workspaces/{ws}/packs/submissions',
    reason:
      /*
       * #446 asked for a decision on whether marketplace submission belongs to
       * an agent at all. It does not, and this is the same line #442 drew for
       * shared skills: submitting a pack publishes this workspace's schema to
       * other people, for review, under the workspace's name. Publishing is a
       * decision ABOUT other people, and ADR-0010's reasoning applies unchanged
       * — an agent may prepare the thing and a person presses submit.
       *
       * The READ half is deliberately still reachable (list_pack_submissions):
       * seeing where your own submission stands is ordinary context. And
       * export_pack produces the manifest, so an agent can do all the work up
       * to the publishing act itself.
       */
      "#446 — submitting a pack to the marketplace publishes this workspace's schema under its name, for review by others. An agent may build the manifest (export_pack) and read its status (list_pack_submissions); pressing submit is a human act, the same line #442 draws for publishing a shared skill (ADR-0010).",
  },
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
  /*
   * #491 — narrowed from the whole `/connections` surface to its credential
   * -bearing half. GET (list) moved to `list_connections`: `present()` on the
   * API side never returns a secret, so no read path here can leak one — the
   * same shape as `list_sources` already exposing what is connected. What
   * stays deferred is everything that STORES, ROTATES or TESTS someone's
   * credential, or hands one to a third party (the OAuth start redirect):
   * that trust decision is unchanged from before #491.
   */
  {
    match:
      /^(POST|DELETE) \/api\/v1\/workspaces\/\{ws\}\/connections(\/\{id\}\/(test|resume)|\/\{id\})?$|^GET \/api\/v1\/workspaces\/\{ws\}\/connections\/oauth\/\{provider\}\/start$/,
    reason:
      '#491 — connect (POST), disconnect (DELETE), re-test, resume-after-circuit-break and the OAuth start redirect all touch a stored credential or hand one to a third party. `list_connections` covers the read half; this is deliberately still refused.',
  },
  {
    match: '/api/v1/workspaces/{ws}/connections/providers',
    reason:
      '#507 — the catalog of what COULD be connected, split out of #491, which only answered "what is already connected" (list_connections). Genuinely open, not decided against — filed rather than left as an implicit gap in this rule.',
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
/*
 * #406 areas 1, 2 and 3 were HERE and are now built — record lifecycle (trash,
 * restore, duplicate, move, batch delete/restore), listing in manual order, and
 * everything hanging off a record (history, activity, comments, watchers,
 * backlinks). Their rules are deleted rather than commented out: the dead-rule
 * check below fails a rule that stops matching anything, which is precisely how
 * this file avoids becoming a list of things that used to be true.
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
  /*
   * #406 area 5 (sources) was HERE and is now built — the provider catalog,
   * field discovery, create/reconfigure/delete, sync-now and the run log.
   * Deleted rather than commented out, for the reason the block above gives:
   * the dead-rule check fails a rule that stops matching, which is how this
   * file avoids becoming a list of things that used to be true.
   *
   * What did NOT move: connection credentials, still deferred below. A source
   * is created by REFERENCE to a stored connection, so no secret passes through
   * a tool argument — but an agent also has no way to look a connection id up,
   * which is #491 and is written into create_source's description rather than
   * left to be discovered by failure.
   */
  /*
   * #443 — area 10 (webhooks) shipped its READ and MANAGE half: list_webhooks,
   * list_webhook_deliveries, update_webhook, delete_webhook. Only CREATE is
   * still deferred, and the rule below is narrowed to exactly that rather than
   * deleted, so the coverage report cannot claim a parity this did not deliver.
   */
  {
    match: 'POST /api/v1/workspaces/{ws}/webhooks',
    reason:
      /*
       * Not the usual "not built yet". Creating a subscription MINTS a signing
       * secret and returns it in the response body — `whsec_…`, generated in
       * WebhooksService.create and, as its own comment says, "shown once at
       * create, never listed". An MCP tool result is transcript, so this is the
       * one endpoint in the area whose SUCCESS PATH leaks credential material.
       *
       * And it cannot be softened the obvious way: redacting the secret from the
       * result would create a webhook whose secret nobody can ever recover,
       * since no read path returns it. That is worse than not having the tool.
       *
       * Same landing as sources (#438) and connections: mint it in the app,
       * manage and debug it over MCP. The capability an agent actually reaches
       * for — "call my system when a record changes" — is NOT gated by this: a
       * `send_webhook` / `http_request` action on an automation rule is fully
       * reachable through create_automation.
       */
      "#443 — creating a subscription returns its live signing secret in the response body (shown once, never listed again), and a tool result is transcript. Redacting it is not an option: no read path can return it afterwards. Make the subscription in-app; list_webhooks / update_webhook / delete_webhook / list_webhook_deliveries manage and debug it. Outbound calls in general are reachable via create_automation's send_webhook action.",
  },
  {
    match: /\/automations\/\{id\}\/(test|last-payload|regenerate-hook)/,
    reason:
      /*
       * #443 asked whether this should MERGE with the webhook-subscription rule
       * above. Decided: NO, keep them separate, because they point in opposite
       * directions and one reason cannot be true of both.
       *
       * Above is OUTBOUND — StoryOS calling someone else's endpoint. This is
       * INBOUND — a `webhook_received` trigger, i.e. someone else calling us:
       * dry-running a rule, reading the last payload we RECEIVED, and rotating
       * the token that authenticates the caller. A merged rule would have to
       * describe both and would accurately describe neither, which is the
       * "rule pointing at the wrong thing" failure #390 documents.
       *
       * They do share one property, noted here so the pair stays consistent if
       * either moves: `regenerate-hook` mints a token, so it is deferred for the
       * same secret-in-a-transcript reason as POST /webhooks above.
       */
      '#406 — automation dry-run, last received payload, and hook-token rotation. INBOUND (a webhook_received trigger), deliberately kept separate from the outbound-subscription rule above: one reason cannot describe both directions (#443 decided this rather than leaving two rules to drift). Rule CRUD is already covered; `regenerate-hook` additionally mints a token, so it carries the same secret-in-a-transcript objection.',
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
