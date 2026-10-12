import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SkillsService } from './skills.service';

/**
 * #841 — the unauthenticated read behind a `public` skill's link. Deliberately NO AuthGuard,
 * exactly like PublicFormsController: the token is the only credential, the service resolves
 * the skill from it and never trusts a caller-supplied scope, and per-IP throttling bounds
 * guessing. Read-only by construction; there is no write route here.
 */
@ApiTags('public')
@Controller('public/skills')
export class PublicSkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get(':token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'A public skill, by its link token (portable fields only)' })
  get(@Param('token') token: string) {
    return this.skills.getPublic(token);
  }
}
