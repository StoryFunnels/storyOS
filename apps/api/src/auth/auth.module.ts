import { Global, Module } from '@nestjs/common';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { createAuth } from './auth';
import { AuthGuard } from './auth.guard';
import { AUTH } from './auth.tokens';

export { AUTH } from './auth.tokens';

@Global()
@Module({
  providers: [
    { provide: AUTH, useFactory: (db: Db) => createAuth(db), inject: [DB] },
    AuthGuard,
  ],
  exports: [AUTH, AuthGuard],
})
export class AuthModule {}
