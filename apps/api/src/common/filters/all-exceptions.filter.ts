import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationException } from 'nestjs-zod';
import { WriteHeldForApprovalException } from '../write-held-for-approval.exception';

/** The single error envelope — docs/architecture/api-conventions.md. */
interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Array<{ path?: string; message: string }>;
    /** Structured, machine-readable facts about the refusal — figures and flags, never prose. */
    meta?: Record<string, unknown>;
    request_id: string;
  };
}

const SPECIFIC_CODE = /^[a-z][a-z0-9_]{2,63}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'validation_failed',
  429: 'rate_limited',
};

/**
 * #1064 — Postgres refusing to CAST a value to uuid/integer ("invalid input syntax for type uuid: \"not-a-uuid\"", SQLSTATE 22P02).
 * That is a malformed identifier from the caller, never a server fault: it can name nothing. Drizzle wraps the driver error, so the
 * cause chain is walked. Only uuid/integer casts: a 22P02 from an enum or a number the SERVER built would be a real bug and stays 5xx.
 */
const MALFORMED_ID = /invalid input syntax for type (uuid|integer|bigint|smallint)/i;
function isMalformedIdError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 6; e = (e as { cause?: unknown }).cause, depth++) {
    const err = e as { code?: unknown; message?: unknown };
    if (err.code === '22P02' && typeof err.message === 'string' && MALFORMED_ID.test(err.message)) return true;
  }
  return false;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const requestId = String(request.id ?? 'unknown');

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let details: ErrorEnvelope['error']['details'];
    let meta: ErrorEnvelope['error']['meta'];
    let code = 'internal_error';

    // #1104 — not an error: the write is staged for approval. The body is the approval handle, not the error envelope.
    if (exception instanceof WriteHeldForApprovalException) {
      void reply.status(HttpStatus.ACCEPTED).send(exception.getResponse());
      return;
    }

    if (exception instanceof ZodValidationException) {
      status = HttpStatus.UNPROCESSABLE_ENTITY;
      code = 'validation_failed';
      message = 'Request validation failed';
      const zodError = exception.getZodError() as {
        issues: Array<{ path: PropertyKey[]; message: string }>;
      };
      details = zodError.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }));
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = CODE_BY_STATUS[status] ?? 'error';
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else {
        const bodyObj = body as {
          message?: string | string[];
          details?: ErrorEnvelope['error']['details'];
          code?: unknown;
          meta?: unknown;
        };
        message = bodyObj.message?.toString() ?? exception.message;
        if (Array.isArray(bodyObj.details)) details = bodyObj.details;
        // A thrower may name a specific code and attach structured facts (see
        // coded-exception.ts). Anything malformed is ignored, so the status-derived
        // default still applies rather than a half-honoured code.
        if (typeof bodyObj.code === 'string' && SPECIFIC_CODE.test(bodyObj.code)) code = bodyObj.code;
        if (isPlainObject(bodyObj.meta)) meta = bodyObj.meta;
      }
    } else if (isMalformedIdError(exception)) {
      // A malformed id in the PATH names nothing, so it is "not found", exactly like a well-formed id that does not exist (the
      // no-leak convention: it must not be distinguishable). In a body or query string it is the caller's bad input instead.
      const inPath = Object.keys((request.params as Record<string, unknown> | undefined) ?? {}).length > 0;
      status = inPath ? HttpStatus.NOT_FOUND : HttpStatus.BAD_REQUEST;
      code = inPath ? 'not_found' : 'bad_request';
      message = inPath ? 'Not found' : 'A value is not a valid identifier';
    } else {
      this.logger.error(
        { requestId, err: exception instanceof Error ? exception.stack : exception },
        'Unhandled exception',
      );
    }

    const envelope: ErrorEnvelope = {
      error: { code, message, ...(details ? { details } : {}), ...(meta ? { meta } : {}), request_id: requestId },
    };

    // `Retry-After` is the standard way to say "come back in N seconds"; a client that
    // honours it needs no knowledge of this API's envelope.
    const retryAfter = Number(meta?.retry_after_seconds);
    if (Number.isFinite(retryAfter) && retryAfter > 0) reply.header('retry-after', String(Math.ceil(retryAfter)));

    void reply.status(status).send(envelope);
  }
}
