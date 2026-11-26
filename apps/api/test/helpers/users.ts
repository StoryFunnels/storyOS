import { eq } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DB } from '../../src/db/db.module';
import type { Db } from '../../src/db/client';
import { user } from '../../src/db/schema';

let counter = 0;

/**
 * Signs up a fresh user and returns their bearer session token.
 *
 * The address is marked VERIFIED by default (ticket #1347): accepting an invite now needs a verified address, and most suites sign
 * people up only so they can be invited. A real sign-up leaves the address unverified until the emailed link is used, so pass
 * `{ verified: false }` for the tests whose point is the unverified account.
 */
export async function signUpUser(
  app: NestFastifyApplication,
  name: string,
  opts: { verified?: boolean } = {},
): Promise<{ token: string; email: string }> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const email = `${slug}-${Date.now()}-${counter++}@test.storyos.dev`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-up/email',
    payload: { email, password: 'test-password-123', name },
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  if (opts.verified !== false) {
    await app.get<Db>(DB).update(user).set({ emailVerified: true }).where(eq(user.email, email));
  }
  return { token: String(res.headers['set-auth-token']), email };
}

export function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}
