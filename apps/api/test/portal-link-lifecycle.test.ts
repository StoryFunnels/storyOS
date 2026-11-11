import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHmac } from 'node:crypto';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * Ticket #536, the parts ruled safe: (a) create / rotate / revoke of a portal recipient link are in the audit log, (b) revoke is
 * idempotent, (c) every dead link gets ONE response. Nothing here changes a token or a signature, and nothing sets policy
 * (expiry, sharing, session durability, email verification) or hashes a token: those stay open on the ticket.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let wsId: string;
let spaceId: string;
let dbId: string;
let viewId: string;
let ownerApiName: string;
let ownerFieldId: string;
let publicToken: string;
// A second workspace, with its own recipient, to prove a real link presented to the wrong portal is refused the same way.
let otherWsId: string;

const as = (method: string, url: string, payload?: unknown, token = admin.token) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
const pub = (url: string) => app.inject({ method: 'GET', url: `/api/v1${url}` });
const view = (recipient: string) => pub(`/public/views/${publicToken}?recipient=${encodeURIComponent(recipient)}`);

async function newRecipient(label: string, extra: Record<string, unknown> = {}) {
  const res = await as('POST', `/workspaces/${wsId}/portal-recipients`, { label, email: `${label.toLowerCase().replace(/\W+/g, '')}@clients.test`, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; token: string; revokedAt: string | null; label: string };
}
const act = (id: string, action: string) => as('POST', `/workspaces/${wsId}/portal-recipients/${id}/${action}`);

interface AuditRow { type?: string; actor_id?: string | null; actor_name?: string | null; source?: string | null; payload?: { object?: { kind: string; id: string; name: string } }; created_at: string }
async function auditFor(id: string) {
  const res = await as('GET', `/workspaces/${wsId}/audit-log?limit=100&type=portal_recipient.created,portal_recipient.rotated,portal_recipient.revoked&entity=${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data as AuditRow[]).filter((e) => e.payload?.object?.id === id);
}

/** What a caller can observe: status, body, and every header except the per-request id and the date. */
function observable(res: { statusCode: number; body: string; headers: Record<string, unknown> }) {
  const body = JSON.parse(res.body) as { error?: { request_id?: string } };
  if (body.error) delete body.error.request_id;
  const headers = { ...res.headers };
  // The rate-limit countdown is a per-caller counter, not information about the link.
  for (const h of ['x-request-id', 'date', 'content-length', 'x-ratelimit-remaining']) delete headers[h];
  return { status: res.statusCode, body, headers };
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'PortalLinkOwner');
  wsId = (await as('POST', '/workspaces', { name: '536 WS' })).json().id;
  spaceId = (await as('GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  dbId = (await as('POST', `/workspaces/${wsId}/databases`, { space_id: spaceId, name: 'Deliverables' })).json().id;
  const ownerField = (await as('POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Owner Email', type: 'email' })).json();
  ownerApiName = ownerField.apiName;
  ownerFieldId = ownerField.id;
  viewId = (await as('GET', `/workspaces/${wsId}/databases/${dbId}`)).json().views[0].id;
  const shared = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${viewId}/share`, { recipient_scope_field_api_name: ownerApiName });
  expect(shared.statusCode, shared.body).toBeLessThan(300);
  publicToken = shared.json().token as string;
  otherWsId = (await as('POST', '/workspaces', { name: '536 Other WS' })).json().id;
}, 120_000);

afterAll(async () => {
  await app.close();
});

describe('ticket #536 (c): every dead link is the same response', () => {
  it('a valid link still works', async () => {
    const r = await newRecipient('Live Co');
    const res = await view(r.token);
    expect(res.statusCode, res.body).toBe(200);
  });

  it('expired, revoked, rotated-old, tampered, malformed, unknown and wrong-portal links all answer identically (404)', async () => {
    const expired = await newRecipient('Expired Co', { expires_at: new Date(Date.now() - 60_000).toISOString() });
    const revoked = await newRecipient('Revoked Co');
    await act(revoked.id, 'revoke');
    const rotatedOld = await newRecipient('Rotated Co');
    await act(rotatedOld.id, 'rotate');
    const live = await newRecipient('Tamper Co');
    const [id, version] = live.token.split('.');
    const tampered = `${id}.${version}.deadbeef${'0'.repeat(56)}`;
    // Signed correctly, version and all, for an id that has no row: unknown, not merely malformed.
    const unknownId = '00000000-0000-4000-8000-000000000536';
    const unknown = `${unknownId}.0.${createHmac('sha256', process.env.BETTER_AUTH_SECRET ?? '').update(`portal-recipient:${unknownId}:0`).digest('hex')}`;
    const foreign = (await as('POST', `/workspaces/${otherWsId}/portal-recipients`, { label: 'Foreign Co' })).json().token as string;

    const dead: Record<string, string> = {
      expired: expired.token,
      revoked: revoked.token,
      'rotated-old': rotatedOld.token,
      tampered,
      malformed: 'not-a-real-token',
      unknown,
      'wrong portal': foreign,
    };
    const seen: Array<{ name: string; res: ReturnType<typeof observable> }> = [];
    for (const [name, token] of Object.entries(dead)) {
      const res = await view(token);
      expect(res.statusCode, `${name}: ${res.body}`).toBe(404);
      seen.push({ name, res: observable(res) });
    }
    const first = seen[0]!;
    for (const s of seen) expect(s.res, `${s.name} differs from ${first.name}`).toEqual(first.res);
    // And the text names nothing: no word that says which of the reasons it was.
    expect(JSON.stringify(first.res.body)).not.toMatch(/revoked|expired|rotated|tamper|invalid|forbidden/i);
  });

  it('the write-back form path answers a wrong-portal link the same way', async () => {
    const foreign = (await as('POST', `/workspaces/${otherWsId}/portal-recipients`, { label: 'Foreign Form Co' })).json().token as string;
    const garbage = await newRecipient('Garbage Form Co');
    await act(garbage.id, 'revoke');
    const formToken = 'tok-536-dead-link-form';
    const formView = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views`, {
      name: 'Intake 536',
      type: 'form',
      config: { sorts: [], hidden_field_ids: [], card_field_ids: [], column_widths: {}, form: { title: 'Intake', access: 'public', public_token: formToken, fields: [{ field_id: ownerFieldId }] } },
    });
    expect(formView.statusCode, formView.body).toBe(201);
    const share = await as('POST', `/workspaces/${wsId}/databases/${dbId}/views/${formView.json().id}/share`, { recipient_scope_field_api_name: ownerApiName });
    expect(share.statusCode, share.body).toBeLessThan(300);
    const post = (recipient: string) => app.inject({ method: 'POST', url: `/api/v1/public/forms/${formToken}`, payload: { values: {}, recipient } });
    const a = await post(foreign);
    const b = await post(garbage.token);
    expect([a.statusCode, b.statusCode]).toEqual([404, 404]);
    expect(observable(a)).toEqual(observable(b));
  });

  it('a request with NO recipient is not a dead link and keeps its own 403', async () => {
    expect((await pub(`/public/views/${publicToken}`)).statusCode).toBe(403);
  });
});

describe('ticket #536: existing live links keep working', () => {
  it('a link minted before this change (same token shape, nothing stored) resolves, and survives an unrelated revoke elsewhere', async () => {
    const r = await newRecipient('Old Link Co');
    const other = await newRecipient('Neighbour Co');
    await act(other.id, 'revoke');
    // The token is the re-derived id.version.hmac the list endpoint already served: reading it back gives the identical string.
    const listed = (await as('GET', `/workspaces/${wsId}/portal-recipients`)).json() as Array<{ id: string; token: string }>;
    expect(listed.find((x) => x.id === r.id)!.token).toBe(r.token);
    expect((await view(r.token)).statusCode).toBe(200);
  });
});

describe('ticket #536 (b): revoke is idempotent', () => {
  it('a second revoke keeps the ORIGINAL revokedAt, answers the same shape, and writes no new audit entry', async () => {
    const r = await newRecipient('Twice Co');
    const first = await act(r.id, 'revoke');
    expect(first.statusCode, first.body).toBeLessThan(300);
    expect(first.json().revokedAt).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 25)); // a later clock tick, so an overwrite would be visible
    const second = await act(r.id, 'revoke');
    expect(second.statusCode, second.body).toBe(first.statusCode);
    expect(second.json()).toEqual(first.json());
    expect(second.json().revokedAt).toBe(first.json().revokedAt);
    expect((await auditFor(r.id)).filter((e) => e.type === 'portal_recipient.revoked')).toHaveLength(1);
    const listed = (await as('GET', `/workspaces/${wsId}/portal-recipients`)).json() as Array<{ id: string; revokedAt: string }>;
    expect(listed.find((x) => x.id === r.id)!.revokedAt).toBe(first.json().revokedAt);
  });

  it('revoking a recipient of another workspace is still a 404, not a silent success', async () => {
    const foreign = (await as('POST', `/workspaces/${otherWsId}/portal-recipients`, { label: 'Not Yours' })).json().id as string;
    expect((await act(foreign, 'revoke')).statusCode).toBe(404);
  });
});

describe('ticket #536 (a): create, rotate and revoke are in the audit log', () => {
  it('each writes exactly one entry naming the recipient and the member, and none carries the credential', async () => {
    const r = await newRecipient('Audited Co');
    const rotated = await act(r.id, 'rotate');
    expect(rotated.statusCode, rotated.body).toBeLessThan(300);
    const newToken = rotated.json().token as string;
    await act(r.id, 'revoke');

    const rows = await auditFor(r.id);
    expect(rows.map((e) => e.type).sort()).toEqual(['portal_recipient.created', 'portal_recipient.revoked', 'portal_recipient.rotated']);
    for (const e of rows) {
      expect(e).toMatchObject({ actor_name: 'PortalLinkOwner', source: 'human', payload: { object: { kind: 'portal_recipient', id: r.id, name: 'Audited Co' } } });
      expect(e.actor_id).toBeTruthy();
    }
    // Never the raw token, its signature, or its version, in any row the audit log serves.
    const everything = JSON.stringify((await as('GET', `/workspaces/${wsId}/audit-log?limit=100`)).json());
    const sig = (t: string) => t.split('.')[2]!;
    for (const secret of [r.token, newToken, sig(r.token), sig(newToken)]) expect(everything).not.toContain(secret);
  });

  it('a rotate of a missing recipient writes nothing', async () => {
    const res = await act('00000000-0000-4000-8000-000000000999', 'rotate');
    expect(res.statusCode).toBe(404);
    expect(await auditFor('00000000-0000-4000-8000-000000000999')).toHaveLength(0);
  });
});
