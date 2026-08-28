import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #448 — the relation graph in one call.
 *
 * The assertion that carries this file is the GUEST one. A relation is visible
 * only when the viewer can read BOTH databases, and an unreadable side drops
 * the edge entirely — no placeholder node, because a placeholder leaks the same
 * fact (a database exists over there, connected to this one) more quietly, and
 * quiet leaks are the ones nobody notices.
 *
 * Only guests can hold partial access, so a test without a guest fixture would
 * prove nothing about that rule at all.
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let guest: { token: string; email: string };
let wsId: string;
let openSpace: string;
let secretSpace: string;
let tasks: string;
let notes: string;
let secrets: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function relate(a: string, b: string, extra: Record<string, unknown> = {}) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/relations`, {
    database_a_id: a,
    database_b_id: b,
    cardinality: 'one_to_many',
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'GraphOwner');
  guest = await signUpUser(app, 'GraphGuest');
  const guestId = (await as(guest.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Graph WS' })).json().id;
  openSpace = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  secretSpace = (await as(admin.token, 'POST', `/workspaces/${wsId}/spaces`, { name: 'Secret' })).json().id;

  tasks = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: openSpace, name: 'Tasks' })).json().id;
  notes = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: openSpace, name: 'Notes' })).json().id;
  secrets = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: secretSpace, name: 'Secrets' })).json().id;

  await relate(tasks, notes, { field_a_name: 'Note', field_b_name: 'Tasks' });
  // A relation reaching INTO a space the guest cannot see — the leak case.
  await relate(tasks, secrets, { field_a_name: 'Secret', field_b_name: 'Tasks' });
  // A self-relation: one relation, two fields, same database.
  await relate(tasks, tasks, { field_a_name: 'Parent', field_b_name: 'Sub-items' });

  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: guest.email,
    role: 'guest',
    grants: [{ space_id: openSpace, role: 'viewer' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(guest.token, 'POST', '/invites/accept', { token });
});

afterAll(async () => {
  await app.close();
});

describe('#448 — GET /relations', () => {
  it('returns the whole graph in ONE call', async () => {
    // The point of the ticket: this replaces list_databases + describe_database
    // × N + de-duplicating both sides of every relation by hand.
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/relations`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toHaveLength(3);
  });

  it('returns ONE entry per relation, not one per side', async () => {
    // Returning both sides separately would push the de-duplication back onto
    // every caller, which is what made the old workaround error-prone.
    const data = (await as(admin.token, 'GET', `/workspaces/${wsId}/relations`)).json().data;
    const ids = data.map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves both endpoints — database and field names, so an edge reads as a sentence', async () => {
    const data = (await as(admin.token, 'GET', `/workspaces/${wsId}/relations`)).json().data;
    const edge = data.find((r: { a: { field_name: string } }) => r.a.field_name === 'Note');
    expect(edge.a).toMatchObject({ database_name: 'Tasks', field_name: 'Note' });
    expect(edge.b).toMatchObject({ database_name: 'Notes', field_name: 'Tasks' });
    expect(edge.cardinality).toBe('one_to_many');
    expect(edge.auto_link).toBe(false);
  });

  it('reports a self-relation ONCE, with both field names', async () => {
    // Not twice, and not truncated to one side (#448 AC-5).
    const data = (await as(admin.token, 'GET', `/workspaces/${wsId}/relations`)).json().data;
    const selfs = data.filter((r: { self_relation: boolean }) => r.self_relation);
    expect(selfs).toHaveLength(1);
    expect(selfs[0].a.field_name).toBe('Parent');
    expect(selfs[0].b.field_name).toBe('Sub-items');
  });

  it('narrows by database and by space', async () => {
    const byDb = (await as(admin.token, 'GET', `/workspaces/${wsId}/relations?database=${notes}`)).json().data;
    expect(byDb).toHaveLength(1);
    expect(byDb[0].b.database_name).toBe('Notes');

    const bySpace = (await as(admin.token, 'GET', `/workspaces/${wsId}/relations?space=${secretSpace}`)).json().data;
    expect(bySpace).toHaveLength(1);
  });

  it('DROPS an edge whose far side the guest cannot read — no placeholder', async () => {
    // The leak this endpoint could easily have shipped: a greyed-out node named
    // "Secrets" tells the guest that a database exists, in a space they were
    // never granted, and that it is connected to their work.
    const data = (await as(guest.token, 'GET', `/workspaces/${wsId}/relations`)).json().data;
    const serialised = JSON.stringify(data);
    expect(serialised).not.toContain('Secrets');
    expect(serialised).not.toContain(secrets);
    // And the edges they CAN see are all there — a rule that hid everything
    // would pass the assertion above and be useless.
    expect(data).toHaveLength(2);
  });

  it('still shows the guest the relations wholly inside their grant', async () => {
    const data = (await as(guest.token, 'GET', `/workspaces/${wsId}/relations`)).json().data;
    const names = data.map((r: { a: { field_name: string } }) => r.a.field_name).sort();
    expect(names).toEqual(['Note', 'Parent']);
  });
});
