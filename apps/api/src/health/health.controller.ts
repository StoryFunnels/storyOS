import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

@ApiTags('system')
@Controller('healthz')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  @ApiOperation({ summary: 'Liveness + database connectivity check' })
  async check() {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException('database unreachable');
    }
    return { status: 'ok', db: 'up' };
  }
}
