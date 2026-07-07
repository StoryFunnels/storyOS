import { Controller, Get } from '@nestjs/common';
import { healthSchema } from '@storyos/schemas';
import type { Health } from '@storyos/schemas';

@Controller()
export class AppController {
  @Get()
  health(): Health {
    return healthSchema.parse({ status: 'ok', name: 'StoryOS', version: '0.0.0' });
  }
}
