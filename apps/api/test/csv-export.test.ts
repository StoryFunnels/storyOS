import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * MN-075: the way out. A view exports exactly what it shows; a database exports
 * everything; and the bytes are readable back by the MN-052 importer.
 */
let app: NestFastifyApplication;
let admin: { token: string };
let wsId: string;
let dbId: string;
let stateField: { id: string; options: Array<{ id: string; label: string }> };
let doneOpt: string;
let todoOpt: string;

async function inject(method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(admin.token),
    payload: payload as never,
  });
}

/** Parse a CSV body into rows, honouring quotes — a dumb split would hide bugs. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r') { /* skip */ }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * Build a multipart body by hand — fastify's inject() does not consume a real
 * FormData, so the existing import test does it this way too.
 */
function multipart(fields: Record<string, string>, csv: string) {
  const boundary = 'X-EXPORT-ROUNDTRIP';
  const parts: string[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="export.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`,
  );
  return { payload: parts.join(''), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'Exporter');
  wsId = (await inject('POST', '/workspaces', { name: 'Export WS' })).json().id;
  const spaceId = (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await inject('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Tasks' })).json().id;

  stateField = (
    await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
      display_name: 'State',
      type: 'select',
      options: [{ label: 'To Do' }, { label: 'Done' }],
    })
  ).json();
  todoOpt = stateField.options.find((o) => o.label === 'To Do')!.id;
  doneOpt = stateField.options.find((o) => o.label === 'Done')!.id;

  await inject('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
    display_name: 'Blocked',
    type: 'checkbox',
  });

  await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
    values: { name: 'Alpha', state: todoOpt, blocked: true },
  });
  await inject('POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
    values: { name: 'Beta, with comma', state: doneOpt, blocked: false },
  });
});

afterAll(async () => {
  await app.close();
});

describe('database export (MN-075)', () => {
  it('downloads as an attachment with a dated filename', async () => {
    const res = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/export/csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="Tasks-\d{4}-\d{2}-\d{2}\.csv"/);
  });

  it('exports every record, with select labels — not option ids', async () => {
    const res = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/export/csv`);
    const rows = parseCsv(res.body);
    const header = rows[0]!;
    expect(header).toContain('Name');
    expect(header).toContain('State');

    const stateCol = header.indexOf('State');
    const nameCol = header.indexOf('Name');
    const body = rows.slice(1);
    expect(body).toHaveLength(2);

    const alpha = body.find((r) => r[nameCol] === 'Alpha')!;
    expect(alpha[stateCol], 'a raw option id would be unreadable and would not re-import').toBe('To Do');

    // The comma in a title must not shift the columns.
    const beta = body.find((r) => r[nameCol] === 'Beta, with comma')!;
    expect(beta[header.indexOf('Blocked')]).toBe('false');
  });
});

describe('view export (MN-075)', () => {
  it('respects the view filters, sorts and hidden fields — the CSV is what you see', async () => {
    const stateFieldId = stateField.id;
    const view = (
      await inject('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
        name: 'Done only',
        type: 'table',
        config: {
          filters: { and: [{ field: 'state', op: 'eq', value: doneOpt }] },
          sorts: [{ field: 'name', direction: 'asc' }],
          hidden_field_ids: [stateFieldId],
          card_field_ids: [],
          column_widths: {},
        },
      })
    ).json();

    if (!view.id) throw new Error(`view create failed: ${JSON.stringify(view)}`);
    const res = await inject('GET', `/workspaces/${wsId}/databases/${dbId}/export/csv?view=${view.id}`);
    expect(res.statusCode).toBe(200);
    const rows = parseCsv(res.body);

    expect(rows[0], 'a hidden field must not be a column').not.toContain('State');
    const body = rows.slice(1);
    expect(body, 'the filter must apply').toHaveLength(1);
    expect(body[0]![rows[0]!.indexOf('Name')]).toBe('Beta, with comma');
  });

  it('404s an unknown view rather than silently exporting everything', async () => {
    const res = await inject(
      'GET',
      `/workspaces/${wsId}/databases/${dbId}/export/csv?view=00000000-0000-4000-8000-000000000000`,
    );
    expect(res.statusCode).toBe(404);
  });
});

describe('export → import round-trip (MN-075 AC)', () => {
  it('re-importing an export reproduces the records', async () => {
    const exported = (await inject('GET', `/workspaces/${wsId}/databases/${dbId}/export/csv`)).body;

    const target = (
      await inject('POST', `/workspaces/${wsId}/databases`, {
        space_id: (await inject('GET', `/workspaces/${wsId}/spaces`)).json()[0].id,
        name: 'Round trip',
      })
    ).json().id;
    const state = (
      await inject('POST', `/workspaces/${wsId}/databases/${target}/fields`, {
        display_name: 'State',
        type: 'select',
        options: [{ label: 'To Do' }, { label: 'Done' }],
      })
    ).json();

    const { payload, headers } = multipart(
      {
        mapping: JSON.stringify([
          { column: 'Name', to: { kind: 'title' } },
          { column: 'State', to: { kind: 'existing', field_id: state.id } },
        ]),
        dry_run: 'false',
      },
      exported,
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${wsId}/databases/${target}/import`,
      headers: { ...authed(admin.token), ...headers },
      payload,
    });
    if (res.statusCode !== 201) throw new Error(`import failed ${res.statusCode}: ${res.body.slice(0, 300)}`);
    const back = (await inject('POST', `/workspaces/${wsId}/databases/${target}/records/query`, { limit: 50 })).json().data;
    expect(back).toHaveLength(2);
    const titles = back.map((r: { title: string }) => r.title).sort();
    expect(titles, 'the quoted comma title must survive the round-trip').toEqual([
      'Alpha',
      'Beta, with comma',
    ]);
    const alpha = back.find((r: { title: string }) => r.title === 'Alpha');
    const todoId = state.options.find((o: { label: string }) => o.label === 'To Do').id;
    expect(alpha.values.state, 'the select label re-resolved to an option').toBe(todoId);
  });
});
