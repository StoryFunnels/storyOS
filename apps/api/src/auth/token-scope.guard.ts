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
