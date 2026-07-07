import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;
let recId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

const docUrl = () => `/workspaces/${wsId}/databases/${dbId}/records/${recId}/document`;

const blocknote = (text: string) => [
  { id: 'b1', type: 'paragraph', content: [{ type: 'text', text, styles: {} }] },
];

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Writer');
  wsId = (await inject('POST', '/workspaces', { name: 'Docs WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Articles' })).json().id;
  recId = (await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Brief' } })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('documents (MN-024)', () => {
  it('reads as version 0 before any write', async () => {
    const res = await inject('GET', docUrl());
    expect(res.json()).toMatchObject({ version: 0, content: null });
  });

  it('creates with expected_version 0 and round-trips content', async () => {
    const res = await inject('PUT', docUrl(), {
      content: blocknote('The content brief goes here'),
      expected_version: 0,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().version).toBe(1);

    const read = await inject('GET', docUrl());
    expect(read.json().content[0].content[0].text).toBe('The content brief goes here');
  });

  it('409s on a stale version and includes the current one', async () => {
    const stale = await inject('PUT', docUrl(), {
      content: blocknote('from another tab'),
      expected_version: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.details[0].message).toContain('current version is 1');

    const fresh = await inject('PUT', docUrl(), {
      content: blocknote('v2'),
      expected_version: 1,
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().version).toBe(2);
  });

  it('rejects oversized documents with 422', async () => {
    const res = await inject('PUT', docUrl(), {
      content: blocknote('x'.repeat(2 * 1024 * 1024 + 10)),
      expected_version: 2,
    });
    expect(res.statusCode).toBe(422);
  });

  it('dies with its record', async () => {
    const doomed = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Doomed' } })
    ).json().id;
    await inject('PUT', `/workspaces/${wsId}/databases/${dbId}/records/${doomed}/document`, {
      content: blocknote('bye'),
      expected_version: 0,
    });
    await inject('DELETE', `/workspaces/${wsId}/databases/${dbId}/records/${doomed}`);
    const res = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/records/${doomed}/document`);
    expect(res.statusCode).toBe(404); // record soft-deleted → document unreachable
  });
});
