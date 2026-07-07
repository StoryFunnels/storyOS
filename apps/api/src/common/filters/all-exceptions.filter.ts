import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodValidationException } from 'nestjs-zod';

/** The single error envelope — docs/architecture/api-conventions.md. */
interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Array<{ path?: string; message: string }>;
    request_id: string;
  };
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
    let code = 'internal_error';

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
        const bodyObj = body as { message?: string | string[]; details?: ErrorEnvelope['error']['details'] };
        message = bodyObj.message?.toString() ?? exception.message;
        if (Array.isArray(bodyObj.details)) details = bodyObj.details;
      }
    } else {
      this.logger.error(
        { requestId, err: exception instanceof Error ? exception.stack : exception },
        'Unhandled exception',
      );
    }

    const envelope: ErrorEnvelope = {
      error: { code, message, ...(details ? { details } : {}), request_id: requestId },
    };

    void reply.status(status).send(envelope);
  }
}
