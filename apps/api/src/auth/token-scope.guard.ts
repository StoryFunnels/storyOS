import { SetMetadata } from '@nestjs/common';
import type { TokenScope } from '@storyos/schemas';

/**
 * MN-134 route markers. Enforcement lives in AuthGuard (the one guard that runs on
 * every authenticated route and already holds the token's scope) — these just tag
 * the route so it can read what's required.
 */
export const SCOPE_KEY = 'storyos:tokenScope';
export const RUN_BUTTON_KEY = 'storyos:runButton';

/**
 * The scope an endpoint requires. `@RequiresScope('admin')` on a schema/management
 * route; `@RequiresScope('read')` on a read that happens to POST (query, search).
 * Unmarked routes default by HTTP method: GET → read, everything else → write.
 */
export const RequiresScope = (scope: TokenScope) => SetMetadata(SCOPE_KEY, scope);

/** #1049 — metadata key for routes only a signed-in PERSON may call (see SessionOnly). */
export const SESSION_ONLY_KEY = 'storyos:sessionOnly';

/**
 * Marks a route an API token or an OAuth connection must never call, whatever its scope: account-level routes that have no
 * `:ws` (so no workspace binding applies to them) and change who the person is or what they own (create a workspace, accept an
 * invite, edit the profile). A leaked workspace-bound token must not be able to reach outside its workspace through them.
 */
export const SessionOnly = () => SetMetadata(SESSION_ONLY_KEY, true);

/** Marks the run_button route so a token that withholds it (within write) is refused. */
export const RunButtonRoute = () => SetMetadata(RUN_BUTTON_KEY, true);

/** #1135 — metadata key for routes a Runner RUN CREDENTIAL (ADR-0021 §4) must never call (see NoRunCredential). */
export const NO_RUN_CREDENTIAL_KEY = 'storyos:noRunCredential';

/**
 * #1135 (the outward-tool gate audit, docs/architecture/runner-outward-tool-audit.md) — marks a route a per-run credential is refused,
 * whatever its scope. The route either has an effect that LEAVES StoryOS (a call to a third party under the workspace's credential, a
 * fetch of a URL the caller chose, a push to an external system) or mints a credential wider than the one calling it (Tyron derives its
 * token from the OWNER's role, so a write-capped run credential reaching it would become admin). None of those has a staging path
 * through the approvals flow for an agent yet, so the refusal is the gate: "anything outward still goes through StoryOS approvals"
 * (ADR-0021 §7) holds because the agent cannot do it at all. A person, a PAT and an AI connection are unaffected: this reads only the
 * run stamp, which only a per-run credential carries. Replace a marker with a staging step, never with silence.
 */
export const NoRunCredential = () => SetMetadata(NO_RUN_CREDENTIAL_KEY, true);
