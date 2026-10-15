import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { authed, signUpUser } from './users';

/**
 * #943 — the third kind of person an access test needs: a MEMBER who holds no grant on something restricted. A test without
 * this fixture proves nothing about restriction (the same rule views-and-the-sidebar.md records for guests: "only guests can
 * have partial access, so a test without a GUEST fixture proves nothing". That sentence stopped being true with ADR-0018).
 */
export interface Person {
  token: string;
  email: string;
  id: string;
}

export const call = (app: NestFastifyApplication, token: string | null, method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: token ? authed(token) : {}, payload: payload as never });

/** Sign a person up, invite them to the workspace with `role` (and optional grants), accept, and return them with their user id. */
export async function joinAs(
  app: NestFastifyApplication,
  ownerToken: string,
  ws: string,
  name: string,
  role: 'member' | 'guest',
  grants?: Array<{ space_id?: string; database_id?: string; role: string }>,
): Promise<Person> {
  const user = await signUpUser(app, name);
  const inv = await call(app, ownerToken, 'POST', `/workspaces/${ws}/invites`, { email: user.email, role, ...(grants ? { grants } : {}) });
  if (inv.statusCode !== 201) throw new Error(`invite failed: ${inv.body}`);
  const ok = await call(app, user.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
  if (ok.statusCode !== 201) throw new Error(`accept failed: ${ok.body}`);
  const me = (await call(app, user.token, 'GET', '/me')).json();
  return { token: user.token, email: user.email, id: me.id };
}

/** Admin-only: flip the restricted flag on a space or a database. */
export async function setRestricted(app: NestFastifyApplication, ownerToken: string, ws: string, kind: 'space' | 'database', id: string, restricted = true) {
  const url = kind === 'space' ? `/workspaces/${ws}/spaces/${id}` : `/workspaces/${ws}/databases/${id}`;
  const res = await call(app, ownerToken, 'PATCH', url, { restricted });
  if (res.statusCode !== 200) throw new Error(`restrict failed: ${res.statusCode} ${res.body}`);
}

/** Admin-only: give a person a grant (members included). */
export async function grant(app: NestFastifyApplication, ownerToken: string, ws: string, userId: string, scope: { space_id?: string; database_id?: string }, role: string) {
  const res = await call(app, ownerToken, 'POST', `/workspaces/${ws}/grants`, { user_id: userId, ...scope, role });
  if (res.statusCode >= 300) throw new Error(`grant failed: ${res.statusCode} ${res.body}`);
}
