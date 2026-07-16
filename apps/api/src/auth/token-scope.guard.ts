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

/** Marks the run_button route so a token that withholds it (within write) is refused. */
export const RunButtonRoute = () => SetMetadata(RUN_BUTTON_KEY, true);
