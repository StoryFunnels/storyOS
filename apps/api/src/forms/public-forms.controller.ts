import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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
}
