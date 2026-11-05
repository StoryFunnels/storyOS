import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { user } from '../src/db/schema';
import { PlatformAdminService } from '../src/admin/platform-admin.service';

/**
 * #1040 — PLATFORM_ADMIN_EMAIL seeds a platform admin at boot. A real sign-up with that address is NOT enough (anyone can sign
 * up with it before the operator does); the account is seeded only once its email is verified, and then /admin opens for it.
 */
let app: NestFastifyApplication;
let db: Db;
let admins: PlatformAdminService;

beforeAll(async () => {
  app = await createTestApp();
  db = app.get(DB);
  admins = app.get(PlatformAdminService);
});

afterAll(async () => {
  await app.close();
});

describe('seedFromEnv only seeds a verified account (#1040)', () => {
  it('an unverified sign-up with the admin email is not made platform admin; once verified, the next seed grants it', async () => {
    const person = await signUpUser(app, 'Would-be operator');
    const account = await db.query.user.findFirst({ where: eq(user.email, person.email) });
    expect(account?.emailVerified).toBe(false);

    await admins.seedFromEnv(person.email);
    expect(await admins.isPlatformAdmin(account!.id)).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/overview', headers: authed(person.token) })).statusCode).toBe(403);

    await db.update(user).set({ emailVerified: true }).where(eq(user.id, account!.id));
    await admins.seedFromEnv(person.email);
    expect(await admins.isPlatformAdmin(account!.id)).toBe(true);
  });
});
