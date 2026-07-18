import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { FormsService } from './forms.service';

const publicSubmitSchema = z.object({
  values: z.record(z.string(), z.unknown()).default({}),
  /** Honeypot — real users never fill this; bots do. */
  hp: z.string().optional(),
});
class PublicSubmitDto extends createZodDto(publicSubmitSchema) {}

const createRelationTargetSchema = z.object({
  title: z.string().trim().min(1).max(500),
});
class CreateRelationTargetDto extends createZodDto(createRelationTargetSchema) {}

/**
 * Public form endpoints (MN-101) — deliberately NO AuthGuard. The `token` is the
 * only credential; the service resolves the workspace/database from it and never
 * trusts any caller-supplied scope. Submission is per-IP throttled.
 */
@ApiTags('public')
@Controller('public/forms')
export class PublicFormsController {
  constructor(private readonly forms: FormsService) {}

  @Get(':token')
  @ApiOperation({ summary: 'Public form definition (link/public access only)' })
  get(@Param('token') token: string) {
    return this.forms.getDefinition(token);
  }

  @Post(':token')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Submit a public form → creates a record (anonymous)' })
  submit(@Param('token') token: string, @Body() body: PublicSubmitDto) {
    return this.forms.submit(token, body.values, body.hp);
  }

  /**
   * Candidate records for a public form's relation field (MN-224). Read-only
   * title search, scoped to a field the form actually exposes — see
   * FormsService.resolveRelationField for the scoping.
   */
  @Get(':token/relations/:fieldId')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Search candidate records for a public form relation field' })
  searchRelation(
    @Param('token') token: string,
    @Param('fieldId') fieldId: string,
    @Query('q') q?: string,
  ) {
    return this.forms.searchRelationCandidates(token, fieldId, q);
  }

  /**
   * Inline "create new" for a public form's relation field (MN-224). Minimal —
   * title only, no other values — and throttled like the main submit.
   */
  @Post(':token/relations/:fieldId')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a new linked record from a public form relation field' })
  createRelationTarget(
    @Param('token') token: string,
    @Param('fieldId') fieldId: string,
    @Body() body: CreateRelationTargetDto,
  ) {
    return this.forms.createRelationTarget(token, fieldId, body.title);
  }
}
