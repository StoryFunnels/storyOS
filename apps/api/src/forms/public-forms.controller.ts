import { Body, Controller, Get, Param, Post, Query, Req, UnprocessableEntityException } from '@nestjs/common';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { createZodDto, ZodValidationException } from 'nestjs-zod';
import { z } from 'zod';
import { FormsService } from './forms.service';

const publicSubmitSchema = z.object({
  values: z.record(z.string(), z.unknown()).default({}),
  /** Honeypot — real users never fill this; bots do. */
  hp: z.string().optional(),
  /** #538 — a portal recipient's bearer token, same shape/param name as
   *  PublicViewsService's `opts.recipient`. Only meaningful (and required)
   *  when the form's own view has `config.share.recipient_scope_field_api_name`
   *  set; ignored otherwise, so an ordinary public form is unaffected. */
  recipient: z.string().optional(),
  /** #538 — present only to EDIT an existing record through a portal form
   *  (never available on an ordinary public form); the record must already
   *  belong to the resolving recipient's scope. */
  record_id: z.uuid().optional(),
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

  /**
   * #710 — accepts EITHER a JSON body (unchanged, MUST KEEP WORKING) or a
   * multipart submission (when the form has an attachment field). Multipart
   * can't go through `@Body()` + the global ZodValidationPipe: `@fastify/
   * multipart` deliberately does NOT populate `req.body` (no
   * `attachFieldsToBody`), so a Zod DTO parameter here would see `undefined`
   * and 400 before this method's own body ever runs. Both branches end up
   * validated against the exact same `publicSubmitSchema`, just parsed from
   * a different place — a multipart submission carries it as a `payload`
   * text part (JSON-encoded), plus at most one file part (the global
   * `@fastify/multipart` registration caps a request at one file — see
   * `app.setup.ts`).
   */
  @Post(':token')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiOperation({
    summary:
      'Submit a public form → creates or (portal-scoped) edits a record (anonymous). ' +
      'Multipart with a "payload" JSON text part when the form has an attachment field.',
  })
  async submit(@Param('token') token: string, @Req() req: FastifyRequest) {
    if (req.isMultipart()) {
      const { body, file } = await this.parseMultipartSubmission(req);
      return this.forms.submit(token, body.values, body.hp, body.recipient, body.record_id, file);
    }
    const body = this.parseJsonBody(req.body);
    return this.forms.submit(token, body.values, body.hp, body.recipient, body.record_id);
  }

  private parseJsonBody(raw: unknown): PublicSubmitDto {
    try {
      return publicSubmitSchema.parse(raw);
    } catch (err) {
      throw new ZodValidationException(err as z.ZodError);
    }
  }

  /**
   * Reads a multipart submission part by part (not `req.file()`, which only
   * ever surfaces one — here we also need the `payload` text field).
   *
   * #710 AC0/AC5 — one attachment field per form, forced by the global
   * `files: 1` plugin limit (app.setup.ts). A second file must fail with a
   * CLEAR, INTENTIONAL error, not whatever the plugin does when it trips
   * that limit: busboy aborts the WHOLE parse and rejects the `parts()`
   * iterator with `FilesLimitError` (`code: 'FST_FILES_LIMIT'`) the moment
   * it sees a second file part — it never yields that part for our own
   * `if (file)` check below to catch. Both paths are handled so the error is
   * clean either way this ever fires.
   */
  private async parseMultipartSubmission(
    req: FastifyRequest,
  ): Promise<{ body: PublicSubmitDto; file?: { filename: string; mime: string; data: Buffer } }> {
    let payloadRaw: unknown = {};
    let file: { filename: string; mime: string; data: Buffer } | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (file) throw new UnprocessableEntityException('only one file may be submitted');
          let data: Buffer;
          try {
            data = await part.toBuffer();
          } catch {
            throw new UnprocessableEntityException('File exceeds the configured size limit');
          }
          file = { filename: part.filename, mime: part.mimetype, data };
        } else if (part.fieldname === 'payload') {
          try {
            payloadRaw = JSON.parse(String(part.value));
          } catch {
            throw new UnprocessableEntityException('"payload" must be valid JSON');
          }
        }
      }
    } catch (err) {
      if (err instanceof UnprocessableEntityException) throw err;
      if ((err as { code?: string } | undefined)?.code === 'FST_FILES_LIMIT') {
        throw new UnprocessableEntityException('only one file may be submitted');
      }
      throw err;
    }
    return { body: this.parseJsonBody(payloadRaw), file };
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
