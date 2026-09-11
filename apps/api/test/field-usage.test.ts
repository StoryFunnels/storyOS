import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Usage Checker');
  wsId = (await inject('POST', '/workspaces', { name: 'Usage WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;
});

afterAll(async () => {
  await app.close();
});

describe('GET /fields/:field/usage (#681)', () => {
  it('reports records, a referencing view, automation and formula together; an unreferenced field reports none', async () => {
    const budget = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Budget',
        type: 'number',
        config: {},
      })
    ).json();
    const untouched = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Untouched',
        type: 'text',
        config: {},
      })
    ).json();

    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { budget: 100 } });
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { budget: 200 } });

    const view = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
        name: 'Big budget',
        type: 'table',
        config: { filters: { field: budget.apiName, op: 'gt', value: 50 } },
      })
    ).json();

    const automation = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
        name: 'Flag overspend',
        trigger: { type: 'record_updated', field_id: budget.id },
        actions: [{ type: 'add_comment', body_template: 'Over budget' }],
      })
    ).json();

    const formula = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Doubled',
        type: 'formula',
        config: { expression: '{Budget} * 2' },
      })
    ).json();

    const usage = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/fields/${budget.id}/usage`);
    expect(usage.statusCode, usage.body).toBe(200);
    const body = usage.json();
    expect(body.records_with_value).toBe(2);
    expect(body.views.map((v: { id: string }) => v.id)).toEqual([view.id]);
    expect(body.automations.map((a: { id: string }) => a.id)).toEqual([automation.id]);
    expect(body.formulas.map((f: { id: string }) => f.id)).toEqual([formula.id]);

    const clean = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/fields/${untouched.id}/usage`);
    expect(clean.json()).toEqual({ records_with_value: 0, views: [], automations: [], formulas: [] });
  });

  it('detects a condition (not just a trigger) referencing the field', async () => {
    const priority = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Priority',
        type: 'select',
        config: {},
        options: [{ label: 'High' }],
      })
    ).json();
    const highId = priority.options[0].id;

    const automation = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/automations`, {
        name: 'On any change, escalate if high',
        trigger: { type: 'record_created' },
        condition: { field: priority.apiName, op: 'has', value: [highId] },
        actions: [{ type: 'add_comment', body_template: 'High priority' }],
      })
    ).json();

    const usage = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/fields/${priority.id}/usage`);
    expect(usage.json().automations.map((a: { id: string }) => a.id)).toEqual([automation.id]);
  });

  it('detects a cross-relation formula reference on the OTHER database', async () => {
    const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const projectsDb = (
      await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Projects' })
    ).json();
    const cost = (
      await inject('POST', `/workspaces/${wsId}/databases/${projectsDb.id}/fields`, {
        display_name: 'Cost',
        type: 'number',
        config: {},
      })
    ).json();

    const relation = (
      await inject('POST', `/workspaces/${wsId}/relations`, {
        database_a_id: dbId,
        database_b_id: projectsDb.id,
        cardinality: 'one_to_many',
        field_a_name: 'Project',
        field_b_name: 'Tasks',
      })
    ).json();

    const rollupLikeFormula = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Project cost',
        type: 'formula',
        config: { expression: `{${relation.field_a.display_name}.Cost}` },
      })
    ).json();

    const usage = await inject('GET', `/workspaces/${wsId}/databases/${projectsDb.id}/fields/${cost.id}/usage`);
    expect(usage.json().formulas).toEqual([
      { id: rollupLikeFormula.id, display_name: 'Project cost', database_id: dbId },
    ]);
  });
});
