import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

/** Scalar API reference UI, reading the live spec from /api/v1/openapi.json. */
@ApiExcludeController()
@Controller('api/docs')
export class DocsController {
  @Get()
  @Header('content-type', 'text/html')
  page(): string {
    return `<!doctype html>
<html>
  <head>
    <title>StoryOS API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/api/v1/openapi.json"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
  }
}
