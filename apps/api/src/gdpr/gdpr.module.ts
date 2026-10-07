import { Module } from '@nestjs/common';
import { MembersDbModule } from '../members/members-db.module';
import { GdprController } from './gdpr.controller';
import { GdprService } from './gdpr.service';

/** GDPR data-subject tooling (MN-233): export-all + erase/anonymize. */
@Module({
  imports: [MembersDbModule],
  controllers: [GdprController],
  providers: [GdprService],
})
export class GdprModule {}
