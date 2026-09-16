import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #474 phase 7 (verification, not a fix) — CSV export for a guest whose only
 * access to a database is one or more record-scoped grants (#472).
 *
 * `ExportController.csv` gates entry with `assertAccess(db, 'viewer')`
 * (database-level, correctly falls through to a record-scoped grant per
 * phase 1) and `ExportService.prepareExport` threads `membership` into
 * `RecordsService.query()` — which phase 1 already narrowed via
 * `visibleRecordIds`. The hypothesis: export was ALREADY correctly scoped
 * once phase 1 landed, with nothing left to fix — confirmed here rather
 * than assumed, per this session's own standing rule (#378/#251/#178: a
 * premise of "already shipped" is a thing to verify in code, not infer).
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;
let dbId: string;
let recGranted: string;
let recDenied: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

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

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'ExportScopeOwner');
  guest = await signUpUser(app, 'ExportScopeGuest');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '474p7 Export WS' })).json().id;
  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Briefs' })).json().id;

  recGranted = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Granted Brief' } })).json().id;
  recDenied = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: { name: 'Denied Brief' } })).json().id;

  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ record_id: recGranted, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('#474 phase 7 — CSV export for a record-scoped-only guest (verification)', () => {
  it('reaches the export endpoint at all (the record-scoped grant fallback from phase 1)', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/export/csv`);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('the exported CSV contains ONLY the granted record, never the denied sibling', async () => {
    const res = await as(guest.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/export/csv`);
    const rows = parseCsv(res.body);
    const nameColIdx = rows[0]!.indexOf('Name');
    const names = rows.slice(1).filter((r) => r.length > 1).map((r) => r[nameColIdx]);
    expect(names).toContain('Granted Brief');
    expect(names).not.toContain('Denied Brief');
  });

  it('the admin (unrestricted) exports every record, unchanged', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/export/csv`);
    const rows = parseCsv(res.body);
    const nameColIdx = rows[0]!.indexOf('Name');
    const names = rows.slice(1).filter((r) => r.length > 1).map((r) => r[nameColIdx]);
    expect(names.sort()).toEqual(['Denied Brief', 'Granted Brief']);
  });
});
