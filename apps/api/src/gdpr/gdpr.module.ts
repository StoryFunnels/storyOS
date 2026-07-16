import { Module } from '@nestjs/common';
import { GdprController } from './gdpr.controller';
import { GdprService } from './gdpr.service';

/** GDPR data-subject tooling (MN-233): export-all + erase/anonymize. */
@Module({
  controllers: [GdprController],
  providers: [GdprService],
})
export class GdprModule {}
