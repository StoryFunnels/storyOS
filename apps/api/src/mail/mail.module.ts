import { Global, Module } from '@nestjs/common';
import { EmailService } from './email.service';

/** Global like DbModule/AuthModule/NotificationsModule — EmailService is a
 * cross-cutting seam every feature module (invites, comments, auth) needs. */
@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class MailModule {}
