import { Global, Module } from '@nestjs/common';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { EmailService } from '../mail/email.service';
import { createAuth } from './auth';
import { AuthGuard } from './auth.guard';
import { AUTH } from './auth.tokens';

export { AUTH } from './auth.tokens';

@Global()
@Module({
  providers: [
    {
      provide: AUTH,
      useFactory: (db: Db, emailService: EmailService) => createAuth(db, emailService),
      inject: [DB, EmailService],
    },
    AuthGuard,
  ],
  exports: [AUTH, AuthGuard],
})
export class AuthModule {}
