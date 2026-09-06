import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #579 (piece 1 of 3) — number field config gets real server-side validation
 * for the first time (create() and update() both previously fell into a
 * generic shallow merge with zero shape checking for this type), and gains a
 * `bins` config for board-grouping. `boardGroupError` widening and the
 * group-read-only write-guard are separate, later pieces of this same ticket
 * — deliberately not touched here, since the ticket requires them to land in
 * the same commit as the web-side groupable-fields.ts widening.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let dbId: string;

async function as(method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'BinsFieldOwner');
  wsId = (await as('POST', '/workspaces', { name: 'Bins WS' })).json().id;
  const spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Deals' })).json().id;
});

afterAll(async () => {
  await app.close();
});

const VALID_BINS = [
  { label: 'Small', min: null, max: 100 },
  { label: 'Medium', min: 100, max: 1000 },
  { label: 'Large', min: 1000, max: null },
];

describe('#579 number field config validation (create)', () => {
  it('accepts a valid contiguous bins array', async () => {
    const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Deal Size',
      type: 'number',
      config: { bins: VALID_BINS },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().config.bins).toEqual(VALID_BINS);
  });

  it('rejects a gap between bins (bin 1 does not start where bin 0 ends)', async () => {
    const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Gappy',
      type: 'number',
      config: { bins: [{ label: 'A', min: null, max: 100 }, { label: 'B', min: 150, max: null }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects overlapping bins', async () => {
    const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Overlapping',
      type: 'number',
      config: { bins: [{ label: 'A', min: null, max: 100 }, { label: 'B', min: 50, max: null }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a middle bin with an unbounded edge', async () => {
    const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Middle Unbounded',
      type: 'number',
      config: { bins: [{ label: 'A', min: null, max: 100 }, { label: 'B', min: 100, max: null }, { label: 'C', min: null, max: 500 }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('rejects a bin whose min is not less than its max', async () => {
    const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Inverted',
      type: 'number',
      config: { bins: [{ label: 'A', min: 100, max: 50 }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('a number field with no bins at all is still created — bins are optional', async () => {
    const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Plain Number',
      type: 'number',
      config: { format: 'plain' },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().config.bins).toBeUndefined();
  });

  it('MUST KEEP WORKING: format/precision/currency_code still validate and save as before', async () => {
    const res = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Price',
      type: 'number',
      config: { format: 'currency', currency_code: 'USD', precision: 2 },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().config).toMatchObject({ format: 'currency', currency_code: 'USD', precision: 2 });
  });
});

describe('#579 number field config validation (update) — the gap the ticket names directly', () => {
  it('a malformed bins array is REJECTED on update, not silently merged (the pre-existing gap)', async () => {
    const created = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Update Target',
      type: 'number',
      config: {},
    });
    const fieldId = created.json().id;

    const patch = await as('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${fieldId}`, {
      config: { bins: [{ label: 'A', min: 100, max: 50 }] },
    });
    expect(patch.statusCode).toBe(422);

    // Confirm nothing was corrupted — the field's config is unchanged.
    const detail = await as('GET', `/workspaces/${wsId}/databases/${dbId}`);
    const field = detail.json().fields.find((f: { id: string }) => f.id === fieldId);
    expect(field.config.bins).toBeUndefined();
  });

  it('a valid bins array is accepted on update', async () => {
    const created = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Update Target Valid',
      type: 'number',
      config: {},
    });
    const fieldId = created.json().id;
    const patch = await as('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${fieldId}`, { config: { bins: VALID_BINS } });
    expect(patch.statusCode, patch.body).toBeLessThan(300);
    expect(patch.json().config.bins).toEqual(VALID_BINS);
  });

  it('MUST KEEP WORKING: patching an unrelated key (format) on a number field still works with no bins present', async () => {
    const created = await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'Format Only',
      type: 'number',
      config: {},
    });
    const fieldId = created.json().id;
    const patch = await as('PATCH', `/workspaces/${wsId}/databases/${dbId}/fields/${fieldId}`, { config: { format: 'percent' } });
    expect(patch.statusCode, patch.body).toBeLessThan(300);
    expect(patch.json().config.format).toBe('percent');
  });
});
