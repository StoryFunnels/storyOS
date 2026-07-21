import type { NestFastifyApplication } from '@nestjs/platform-fastify';

let counter = 0;

/** Signs up a fresh user and returns their bearer session token. */
export async function signUpUser(
  app: NestFastifyApplication,
  name: string,
): Promise<{ token: string; email: string }> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const email = `${slug}-${Date.now()}-${counter++}@test.storyos.dev`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-up/email',
    payload: { email, password: 'test-password-123', name },
  });
  if (res.statusCode !== 200) throw new Error(`signup failed: ${res.body}`);
  return { token: String(res.headers['set-auth-token']), email };
}

export function authed(token: string) {
  return { authorization: `Bearer ${token}` };
}
