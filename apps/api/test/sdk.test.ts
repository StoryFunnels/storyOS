import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createStoryOSClient, isErrorEnvelope } from '@storyos/sdk';
import type { StoryOSClient } from '@storyos/sdk';
import { createTestApp } from './helpers/app';

/**
 * MN-013: the generated SDK drives a real listening server end-to-end —
 * signup → create database → add field → create record → query.
 */
let app: NestFastifyApplication;
let client: StoryOSClient;
let baseUrl: string;

beforeAll(async () => {
  app = await createTestApp();
  await app.listen(0, '127.0.0.1');
  baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');

  const signup = await fetch(`${baseUrl}/api/v1/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `sdk-${Date.now()}@test.storyos.dev`,
      password: 'sdk-test-password',
      name: 'SDK User',
    }),
  });
  expect(signup.status).toBe(200);
  const token = signup.headers.get('set-auth-token')!;
  client = createStoryOSClient({ baseUrl, token });
});

afterAll(async () => {
  await app.close();
});

describe('generated SDK (MN-013)', () => {
  let wsId: string;
  let dbId: string;

  it('creates a workspace with full types', async () => {
    const { data, error } = await client.POST('/api/v1/workspaces', {
      body: { name: 'SDK Workspace' },
    });
    expect(error).toBeUndefined();
    wsId = (data as { id: string }).id;
    expect(wsId).toBeTruthy();
  });

  it('walks spaces → database → field → record → query', async () => {
    const spaces = await client.GET('/api/v1/workspaces/{ws}/spaces', {
      params: { path: { ws: wsId } },
    });
    const spaceId = (spaces.data as Array<{ id: string }>)[0]!.id;

    const database = await client.POST('/api/v1/workspaces/{ws}/databases', {
      params: { path: { ws: wsId } },
      body: { space_id: spaceId, name: 'SDK Tasks' },
    });
    dbId = (database.data as { id: string }).id;

    await client.POST('/api/v1/workspaces/{ws}/databases/{db}/fields', {
      params: { path: { ws: wsId, db: dbId } },
      body: { display_name: 'Estimate', type: 'number' },
    });

    const record = await client.POST('/api/v1/workspaces/{ws}/databases/{db}/records', {
      params: { path: { ws: wsId, db: dbId } },
      body: { values: { name: 'Via SDK', estimate: 3 } },
    });
    expect((record.data as { title: string }).title).toBe('Via SDK');

    const query = await client.POST('/api/v1/workspaces/{ws}/databases/{db}/records/query', {
      params: { path: { ws: wsId, db: dbId } },
      body: { filter: { field: 'estimate', op: 'gte', value: 1 } },
    });
    expect((query.data as { data: unknown[] }).data).toHaveLength(1);
  });

  it('surfaces the error envelope with the type guard', async () => {
    const { error } = await client.POST('/api/v1/workspaces/{ws}/databases', {
      params: { path: { ws: wsId } },
      body: { space_id: '00000000-0000-0000-0000-000000000000', name: 'Nope' },
    });
    expect(isErrorEnvelope(error)).toBe(true);
    expect((error as { error: { code: string } }).error.code).toBe('not_found');
  });
});
