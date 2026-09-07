import { Controller, Get } from '@nestjs/common';
import { healthSchema } from '@storyos/schemas';
import type { Health } from '@storyos/schemas';
import { env } from './config/env';

@Controller()
export class AppController {
  @Get()
  health(): Health {
    return healthSchema.parse({
      status: 'ok',
      name: 'StoryOS',
      version: '0.0.0',
      // #553 — unauthenticated by design: a commit sha of a public AGPL repo
      // is not a secret (the repo and every sha in it are public), and the
      // moments this is most needed are exactly when something is
      // misconfigured and an auth dance would be in the way.
      commit_sha: env().GIT_SHA ?? null,
      build_time: env().BUILD_TIME ?? null,
    });
  }
}
