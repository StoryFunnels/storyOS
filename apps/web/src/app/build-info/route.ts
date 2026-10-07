import { NextResponse } from 'next/server';

/**
 * #553 — "what commit is this deployment serving", for the WEB app half (the
 * API answers the same question at `GET /` — see app.controller.ts). Lives
 * OUTSIDE `/api/*` on purpose: the compose Caddyfile proxies every `/api/*`
 * path to the api container, so a route under here would never reach this
 * process at all in a real deployment.
 *
 * Deliberately unauthenticated, same reasoning as the API's endpoint: a
 * commit sha of this public AGPL repository is not a secret, and the moments
 * this is most needed are exactly when something is misconfigured and you
 * aren't sure what you're talking to.
 *
 * `force-dynamic` so this is evaluated at REQUEST time, never cached from
 * whatever the value happened to be when the route was first hit after boot
 * — the whole point is reporting the actual running process's build, not a
 * value frozen at an arbitrary earlier moment.
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({
    // `||`, not `??`: Docker's `ENV GIT_SHA=$GIT_SHA` DEFINES the var (as an
    // empty string) even when the build arg was never passed, so it's never
    // actually `undefined` in a real image — a self-built image with no
    // build args must still report `null`, not "".
    commit_sha: process.env.GIT_SHA || null,
    build_time: process.env.BUILD_TIME || null,
  });
}
