import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';

/**
 * ADR-0019 / #973 — the personal filter (and the personal collection view) lived in ONE jsonb blob per user and every write was a
 * read-modify-write of the whole blob, so two concurrent writes for two DIFFERENT views raced and one silently vanished: 10 of 12
 * rounds in the ADR's measurement. Each override is its own row now, so two writes cannot touch each other.
 */
let app: NestFastifyApplication;
let token: string;
let ws: string, db: string;
const as = (method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const filter = (value: string) => ({ filter: { and: [{ field: 'name', op: 'contains', value }] } });

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Viewer State')).token;
  ws = (await as('POST', '/workspaces', { name: 'VS WS' })).json().id;
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
}, 240_000);
afterAll(async () => { await app.close(); });

const mkView = async (name: string) => (await as('POST', `/workspaces/${ws}/databases/${db}/views`, { name, type: 'table' })).json().id as string;
const putFilter = (view: string, value: string) => as('PUT', `/workspaces/${ws}/databases/${db}/views/${view}/personal-filter`, filter(value));
const getFilter = async (view: string) => (await as('GET', `/workspaces/${ws}/databases/${db}/views/${view}/personal-filter`)).json();

describe('#973 concurrent personal filters never lose each other', () => {
  it('two concurrent writes for two different views: both survive, 100 rounds', async () => {
    let lost = 0;
    const ROUNDS = 100;
    for (let r = 0; r < ROUNDS; r++) {
      const [a, b] = [await mkView(`A${r}`), await mkView(`B${r}`)];
      const [ra, rb] = await Promise.all([putFilter(a, `a${r}`), putFilter(b, `b${r}`)]);
      expect([ra.statusCode, rb.statusCode]).toEqual([200, 200]);
      const [ga, gb] = [await getFilter(a), await getFilter(b)];
      if (!ga.filter || !gb.filter) lost++;
    }
    expect(lost, `${lost} of ${ROUNDS} rounds lost one of the two filters`).toBe(0);
  }, 300_000);
});
