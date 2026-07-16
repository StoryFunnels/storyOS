import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-134: a PAT carries a scope (read | write | admin) chosen at mint time, enforced
 * server-side on EVERY authenticated route — here, in AuthGuard, so it holds even if a
 * controller forgets a guard or an agent hand-crafts a call to an unadvertised tool.
 *
 * read  → GETs only.
 * write → record/content mutations, but not schema.
 * admin → everything, unless allow_run_button withholds button presses.
 */
let app: NestFastifyApplication;
let owner: { token: string };
let ws: string;
let space: string;
let db: string;

async function inject(method: string, url: string, payload?: unknown, token?: string) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token ?? owner.token),
    payload: payload as never,
  });
}

async function mint(scope: string, allowRunButton = true): Promise<string> {
  const res = await inject('POST', '/me/tokens', {
    name: `${scope}${allowRunButton ? '' : '-no-button'}`,
    workspace_id: ws,
    scope,
    allow_run_button: allowRunButton,
  });
  expect(res.statusCode, `mint ${scope}`).toBe(201);
  return res.json().token as string;
}

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'Scoped');
  ws = (await inject('POST', '/workspaces', { name: 'Scope WS' })).json().id;
  space = (await inject('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  db = (await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('a read-scoped PAT (MN-134)', () => {
  let read: string;
  beforeAll(async () => {
    read = await mint('read');
  });

  it('reads records', async () => {
    expect((await inject('GET', `/workspaces/${ws}/databases/${db}/records`, undefined, read)).statusCode).toBe(200);
  });

  it('can run the query endpoint (a POST marked @RequiresScope(read))', async () => {
    const res = await inject('POST', `/workspaces/${ws}/databases/${db}/records/query`, {}, read);
    expect(res.statusCode).toBe(201);
  });

  it('is REFUSED any write — creating a record 403s', async () => {
    const res = await inject('POST', `/workspaces/${ws}/databases/${db}/records`, { values: {} }, read);
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.message ?? res.json().message).toMatch(/read-scoped/);
  });

  it('is REFUSED schema changes — adding a field 403s', async () => {
    const res = await inject(
      'POST',
      `/workspaces/${ws}/databases/${db}/fields`,
      { display_name: 'Priority', type: 'text' },
      read,
    );
    expect(res.statusCode).toBe(403);
  });

  it('/me reports the scope so the MCP can trim its tools', async () => {
    const me = (await inject('GET', '/me', undefined, read)).json();
    expect(me.auth.via).toBe('token');
    expect(me.auth.token_scope).toBe('read');
    // a read token can never press buttons regardless of the flag
    expect(me.auth.allow_run_button).toBe(false);
  });
});

describe('a write-scoped PAT (MN-134)', () => {
  let write: string;
  beforeAll(async () => {
    write = await mint('write');
  });

  it('reads and writes records', async () => {
    expect((await inject('GET', `/workspaces/${ws}/databases/${db}/records`, undefined, write)).statusCode).toBe(200);
    const created = await inject('POST', `/workspaces/${ws}/databases/${db}/records`, { values: {} }, write);
    expect(created.statusCode).toBe(201);
  });

  it('is REFUSED schema changes — adding a field 403s', async () => {
    const res = await inject(
      'POST',
      `/workspaces/${ws}/databases/${db}/fields`,
      { display_name: 'Priority', type: 'text' },
      write,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.message ?? res.json().message).toMatch(/admin access is required/);
  });

  it('is REFUSED creating a database', async () => {
    const res = await inject('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Nope' }, write);
    expect(res.statusCode).toBe(403);
  });
});

describe('an admin-scoped PAT (MN-134)', () => {
  it('can change schema', async () => {
    const admin = await mint('admin');
    const res = await inject(
      'POST',
      `/workspaces/${ws}/databases/${db}/fields`,
      { display_name: 'Priority', type: 'text' },
      admin,
    );
    expect(res.statusCode).toBe(201);
  });

  it('with allow_run_button=false is refused button presses but keeps write', async () => {
    const noButton = await mint('admin', false);
    // write still works
    expect((await inject('POST', `/workspaces/${ws}/databases/${db}/records`, { values: {} }, noButton)).statusCode).toBe(201);
    const me = (await inject('GET', '/me', undefined, noButton)).json();
    expect(me.auth.allow_run_button).toBe(false);
  });
});
