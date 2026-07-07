import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import type { OpenAPIObject } from '@nestjs/swagger';

/** Builds the OpenAPI document — single source shared by runtime serving and the generate script. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('StoryOS API')
    .setDescription(
      'The public StoryOS REST API. The web app is client #1 of this same API — everything the UI does, you can do.',
    )
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();

  return cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
}
