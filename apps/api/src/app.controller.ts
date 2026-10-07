import { Controller, Get } from '@nestjs/common';
import { healthSchema } from '@storyos/schemas';
import type { Health } from '@storyos/schemas';
import { env } from './config/env';

function resolveBuildInfo() {
  return {
    // #553 — unauthenticated by design: a commit sha of a public AGPL repo
    // is not a secret (the repo and every sha in it are public), and the
    // moments this is most needed are exactly when something is
    // misconfigured and an auth dance would be in the way.
    // Docker's `ENV GIT_SHA=$GIT_SHA` DEFINES the var (as an empty string)
    // even when the build arg was never passed, so it's never actually
    // `undefined` in a real image — `??` alone silently reported "" instead
    // of the documented `null`. `||` catches the falsy empty string too; a
    // real sha/timestamp is never falsy, so the meaningful case is unaffected.
    commit_sha: env().GIT_SHA || null,
    build_time: env().BUILD_TIME || null,
  };
}

@Controller()
export class AppController {
  @Get()
  health(): Health {
    return healthSchema.parse({
      status: 'ok',
      name: 'StoryOS',
      version: '0.0.0',
      ...resolveBuildInfo(),
    });
  }

  /**
   * #553 follow-up — Vera found this live: the bare `GET /` endpoint above is
   * genuinely unreachable through the public single-origin Caddy proxy.
   * `docker/Caddyfile` only forwards `/api/*` to this container; `app.setup.ts`
   * deliberately excludes `/` from the `/api/v1` prefix (so `health()` above
   * still answers on a DIRECT hit to this container's own port, e.g. an
   * operator curling `api:3001/` from inside the compose network), which
   * means the catch-all sends every OTHER request — including bare `/` on the
   * public domain — to the web container instead. Confirmed live against
   * staging: `GET https://staging.storyos.dev/` returned the web app's cached
   * HTML, not this JSON.
   *
   * This route has NO explicit path segment excluded from the prefix, so it
   * lands at `/api/v1/build-info` — reachable through the exact same `/api/*`
   * proxy rule the rest of the API already relies on, on both a Caddy-fronted
   * public deployment and a direct hit to the container's own port. `health()`
   * above is left exactly as it was — still correct for whatever already
   * calls it directly — this adds the publicly-reachable path rather than
   * moving the existing one.
   */
  @Get('build-info')
  buildInfo() {
    return resolveBuildInfo();
  }
}
