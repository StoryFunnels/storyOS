import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call } from './helpers/members';

/**
 * #949 — a PATCH whose body carries no recognised key reached the database as an empty UPDATE and came back a 500: a server
 * fault in error monitoring and nothing an API or MCP caller can act on. Every PATCH endpoint is probed with `{}` and with
 * unknown keys only; the answer must be a 4xx that names the problem. (A zod object strips unknown keys, so both bodies are
 * the same empty patch by the time the service sees them.)
 */
let app: NestFastifyApplication;
let token: string;
let ws: string, space: string, db: string, field: string;
const as = (method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const ids: Record<string, string> = {};

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Empty Patch')).token;
  ws = (await as('POST', '/workspaces', { name: 'Empty Patch WS' })).json().id;
  space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  field = (await as('POST', `/workspaces/${ws}/databases/${db}/fields`, { display_name: 'Kind', type: 'select', options: [{ label: 'A', color: 'gray' }] })).json();
  ids.option = field.options?.[0]?.id;
  ids.field = field.id;
  ids.record = (await as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name: 'r' } })).json().id;
  ids.view = (await as('POST', `/workspaces/${ws}/databases/${db}/views`, { name: 'V', type: 'table' })).json().id;
  ids.folder = (await as('POST', `/workspaces/${ws}/spaces/${space}/folders`, { name: 'F' })).json().id;
  ids.group = (await as('POST', `/workspaces/${ws}/space-groups`, { name: 'G' })).json().id;
  ids.doc = (await as('POST', `/workspaces/${ws}/spaces/${space}/documents`, { title: 'D' })).json().id;
  ids.webhook = (await as('POST', `/workspaces/${ws}/webhooks`, { url: 'https://example.com/ep', events: ['record.created'] })).json().id;
}, 240_000);
afterAll(async () => { await app.close(); });

// URLs are thunks: `describe` runs at collection time, before beforeAll has created any of these ids.
const probes: Array<[string, () => string]> = [
  ['workspace', () => `/workspaces/${ws}`],
  ['space', () => `/workspaces/${ws}/spaces/${space}`],
  ['database', () => `/workspaces/${ws}/databases/${db}`],
  ['field', () => `/workspaces/${ws}/databases/${db}/fields/${ids.field}`],
  ['option', () => `/workspaces/${ws}/databases/${db}/fields/${ids.field}/options/${ids.option}`],
  ['view', () => `/workspaces/${ws}/databases/${db}/views/${ids.view}`],
  ['folder', () => `/workspaces/${ws}/folders/${ids.folder}`],
  ['space group', () => `/workspaces/${ws}/space-groups/${ids.group}`],
  ['document', () => `/workspaces/${ws}/documents/${ids.doc}`],
  // webhooks are deliberately absent: an empty PATCH there is a harmless 200 that returns the current row (no empty UPDATE is reached).
  ['record', () => `/workspaces/${ws}/databases/${db}/records/${ids.record}`],
];

/** A real partial update for each, to prove the guard does not catch legitimate patches (a 2xx). */
const valid: Record<string, unknown> = {
  workspace: { name: 'Empty Patch WS renamed' },
  space: { name: 'General renamed' },
  database: { name: 'Tasks renamed' },
  field: { display_name: 'Kind renamed' },
  option: { label: 'A renamed' },
  view: { name: 'V renamed' },
  folder: { name: 'F renamed' },
  'space group': { name: 'G renamed' },
  document: { title: 'D renamed' },
  record: { values: { name: 'r renamed' } },
};

describe('#949 an empty PATCH is a 4xx, never a 500', () => {
  for (const [name, urlOf] of probes) {
    for (const [label, body] of [['an empty body', {}], ['unknown keys only', { definitely_not_a_field: 1 }]] as const) {
      it(`${name}: ${label} is refused, naming what it accepts`, async () => {
        const url = urlOf();
        expect(url, 'a fixture was not created').not.toContain('undefined');
        const res = await as('PATCH', url, body);
        expect(res.statusCode, `${name} ${label}: ${res.body}`).toBe(422);
        expect(res.json().error.message, `${name} ${label}`).not.toBe('Internal server error');
        if (name !== 'record') expect(JSON.stringify(res.json())).toContain('Accepted fields');
      });
    }
    it(`${name}: MUST KEEP WORKING — a real partial update still succeeds`, async () => {
      const res = await as('PATCH', urlOf(), valid[name]);
      expect(res.statusCode, `${name}: ${res.body}`).toBeLessThan(300);
    });
  }

  it('a null value is a value, not an empty patch: clearing a field is still allowed', async () => {
    const res = await as('PATCH', `/workspaces/${ws}/spaces/${space}`, { description: null });
    expect(res.statusCode, res.body).toBeLessThan(300);
  });
});
