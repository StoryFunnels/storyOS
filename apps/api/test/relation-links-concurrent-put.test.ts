/**
 * #686 — two overlapping `PUT .../records/:rec/links/:field` calls for the
 * SAME record+relation used to make the loser 500: `RelationsService.
 * replaceLinks` deletes then inserts inside one transaction with no
 * `onConflictDoNothing`, and `record_links_uq UNIQUE (relation_id,
 * from_record_id, to_record_id)` rejected a concurrent overlapping insert as
 * an unhandled exception. PUT is idempotent-by-definition ("replace the
 * link set") — two concurrent PUTs should both succeed and the result
 * should be exactly ONE of the two requested sets, never a 500 and never a
 * mixture of both.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let projectsDb: string;
let clientsDb: string;
let fieldId: string;
let projectId: string;
let clientIds: string[];

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

const linksUrl = () => `/workspaces/${wsId}/databases/${projectsDb}/records/${projectId}/links/${fieldId}`;

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'ConcurrentLinker686');
  wsId = (await inject('POST', '/workspaces', { name: '686 WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  projectsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects686' })).json().id;
  clientsDb = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Clients686' })).json().id;

  const rel = (await inject('POST', `/workspaces/${wsId}/relations`, {
    database_a_id: projectsDb,
    database_b_id: clientsDb,
    cardinality: 'many_to_many',
    field_a_name: 'Clients',
    field_b_name: 'Projects',
  })).json();
  fieldId = rel.field_a.id;

  projectId = (await inject('POST', `/workspaces/${wsId}/databases/${projectsDb}/records`, { values: { name: 'Redesign686' } })).json().id;
  clientIds = [];
  for (const name of ['A', 'B', 'C', 'D']) {
    clientIds.push(
      (await inject('POST', `/workspaces/${wsId}/databases/${clientsDb}/records`, { values: { name: `Client ${name}` } })).json().id,
    );
  }
});

afterAll(async () => {
  await app.close();
});

describe('#686 concurrent replaceLinks', () => {
  it('two overlapping concurrent PUTs both succeed (never 500), and the result is exactly ONE full requested set', async () => {
    const [clientA, clientB, clientC, clientD] = clientIds;
    // Overlapping sets sharing clientA/clientB — this is what used to hit
    // record_links_uq when both transactions tried to insert the shared id.
    const setX = [clientA, clientB];
    const setY = [clientB, clientC, clientD];

    const [resX, resY] = await Promise.all([
      inject('PUT', linksUrl(), { record_ids: setX }),
      inject('PUT', linksUrl(), { record_ids: setY }),
    ]);

    expect(resX.statusCode, `X: ${resX.body}`).toBeLessThan(300);
    expect(resY.statusCode, `Y: ${resY.body}`).toBeLessThan(300);

    const final = await inject('GET', linksUrl());
    const finalIds = (final.json().data as Array<{ id: string }>).map((c) => c.id).sort();

    const matchesX = JSON.stringify(finalIds) === JSON.stringify([...setX].sort());
    const matchesY = JSON.stringify(finalIds) === JSON.stringify([...setY].sort());
    expect(
      matchesX || matchesY,
      `final link set ${JSON.stringify(finalIds)} must equal exactly setX ${JSON.stringify(setX.sort())} or setY ${JSON.stringify(setY.sort())} — never a mixture`,
    ).toBe(true);
  });

  it('repeated concurrent replace pairs never 500 and never leave a mixture (probabilistic race, run several times)', async () => {
    const [clientA, clientB, clientC, clientD] = clientIds;
    for (let i = 0; i < 8; i++) {
      const setX = i % 2 === 0 ? [clientA, clientC] : [clientA];
      const setY = i % 2 === 0 ? [clientB] : [clientB, clientC, clientD];

      const [resX, resY] = await Promise.all([
        inject('PUT', linksUrl(), { record_ids: setX }),
        inject('PUT', linksUrl(), { record_ids: setY }),
      ]);
      expect(resX.statusCode, `iter ${i} X: ${resX.body}`).toBeLessThan(300);
      expect(resY.statusCode, `iter ${i} Y: ${resY.body}`).toBeLessThan(300);

      const final = await inject('GET', linksUrl());
      const finalIds = (final.json().data as Array<{ id: string }>).map((c) => c.id).sort();
      const matchesX = JSON.stringify(finalIds) === JSON.stringify([...setX].sort());
      const matchesY = JSON.stringify(finalIds) === JSON.stringify([...setY].sort());
      expect(matchesX || matchesY, `iter ${i}: final ${JSON.stringify(finalIds)} is a mixture of setX/setY`).toBe(true);
    }
  });

  it('MUST KEEP WORKING: a normal sequential replace still works exactly as before', async () => {
    const [clientA] = clientIds;
    const res = await inject('PUT', linksUrl(), { record_ids: [clientA] });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const final = await inject('GET', linksUrl());
    expect((final.json().data as Array<{ id: string }>).map((c) => c.id)).toEqual([clientA]);
  });
});
