import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { UsersModule } from '../users/users.module';
import { MyWorkDigestController } from './my-work-digest.controller';
import { MyWorkDigestService } from './my-work-digest.service';

/** Ticket #1251 — the My work email. EmailService is global (MailModule). */
@Module({
  imports: [SearchModule, UsersModule],
  controllers: [MyWorkDigestController],
  providers: [MyWorkDigestService],
  exports: [MyWorkDigestService],
})
export class MyWorkDigestModule {}
