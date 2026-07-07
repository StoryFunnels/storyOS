---
id: MN-005
title: API skeleton — config, error envelope, OpenAPI plumbing
status: done
depends_on: [MN-004]
size: M
---

The NestJS app's structural layer: Fastify adapter, zod-validated env config, global `ZodValidationPipe` (nestjs-zod), the exception filter producing the single error envelope from [docs/architecture/api-conventions.md](../docs/architecture/api-conventions.md), request-id + pino logging, `/healthz`, and the OpenAPI build step (boot app → generate spec → write `docs/api/openapi.json`) with Scalar at `/api/docs`.

## Acceptance criteria

- [ ] Invalid request body → 400 with the envelope: `{error: {code: "validation_failed", details: [{path, message}], request_id}}`
- [ ] Unhandled exceptions → 500 envelope, logged with request id; no stack traces in responses
- [ ] `/healthz` checks DB connectivity
- [ ] `pnpm openapi:generate` writes `docs/api/openapi.json`; CI fails when the committed spec drifts from code
- [ ] Scalar renders the spec at `/api/docs` locally
