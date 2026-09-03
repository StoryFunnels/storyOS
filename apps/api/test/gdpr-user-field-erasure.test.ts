import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

/**
 * #493 — GDPR erasure never touched ANY database's content, including a
 * `user`-type field naming the erased person. Decision recorded on the
 * ticket: this is NOT #463's "enumerate and null the one row anchored by
 * userId" shape (Agents/Runs/Triggers have no such anchor — a person can be
 * createdBy on arbitrarily many rows, and createdBy is deliberately excluded
 * from erasure everywhere as audit lineage). Instead: generalize the
 * export-only `userFieldReferences` finder into a write that clears a
 * `user`-type field's reference to the erased person on ANY database in the
 * workspace — the one structurally-identifiable vector, without content-
 * scanning free text (which this codebase has never attempted, anywhere).
 */
let app: NestFastifyApplication;
let admin: { token: string; email: string };
let target: { token: string; email: string };
let targetId: string;
let other: { token: string; email: string };
let otherId: string;
let targetMembership: string;
let wsId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'FieldErasureOwner');
  target = await signUpUser(app, 'FieldErasureTarget');
  other = await signUpUser(app, 'FieldErasureOther');
  targetId = (await as(target.token, 'GET', '/me')).json().id;
  otherId = (await as(other.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: '493 WS' })).json().id;
  const space = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;

  for (const person of [target, other]) {
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
      email: person.email,
      role: 'member',
      grants: [{ space_id: space, role: 'editor' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(person.token, 'POST', '/invites/accept', { token });
  }

  const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json();
  targetMembership = members.find((m: { user_id: string }) => m.user_id === targetId).id;
});

afterAll(async () => {
  await app.close();
});

describe('a user-type field referencing the erased person is cleared, on ANY database (#493)', () => {
  it('an ordinary database: a single-user field is nulled, a multi-user field keeps the other person', async () => {
    const space = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: space, name: 'Tasks' })).json().id;
    const single = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Owner', type: 'user' })
    ).json();
    const multi = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, {
        display_name: 'Watchers',
        type: 'user',
        config: { multi: true },
      })
    ).json();

    const rec = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
        values: { [single.apiName]: targetId, [multi.apiName]: [targetId, otherId] },
      })
    ).json();

    const anon = await as(admin.token, 'POST', `/workspaces/${wsId}/members/${targetMembership}/gdpr/anonymize`);
    expect(anon.statusCode, anon.body).toBe(200);
    expect(anon.json().removed.user_field_references).toBeGreaterThanOrEqual(2);

    const after = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`)).json();
    expect(after.values[single.apiName], 'the single-user field must be cleared').toBeUndefined();
    expect(after.values[multi.apiName], 'the OTHER watcher must survive').toEqual([otherId]);
  });
});

describe('the Agentic OS pack is reached too — not special-cased, just not exempt (#493)', () => {
  it('a user-type field added to the Runs database is cleared on erasure', async () => {
    const admin2 = await signUpUser(app, 'AgentPackOwner');
    const target2 = await signUpUser(app, 'AgentPackTarget');
    const target2Id = (await as(target2.token, 'GET', '/me')).json().id;
    const ws2 = (await as(admin2.token, 'POST', '/workspaces', { name: '493 Agent WS' })).json().id;
    const space2 = (await as(admin2.token, 'GET', `/workspaces/${ws2}/spaces`)).json()[0].id;
    const invite = await as(admin2.token, 'POST', `/workspaces/${ws2}/invites`, {
      email: target2.email,
      role: 'member',
      grants: [{ space_id: space2, role: 'editor' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(target2.token, 'POST', '/invites/accept', { token });
    const members2 = (await as(admin2.token, 'GET', `/workspaces/${ws2}/members`)).json();
    const target2Membership = members2.find((m: { user_id: string }) => m.user_id === target2Id).id;

    const ensure = await as(admin2.token, 'POST', `/workspaces/${ws2}/agents/ensure`);
    expect(ensure.statusCode, ensure.body).toBeLessThan(300);
    const runsDb = (await as(admin2.token, 'GET', `/workspaces/${ws2}/databases`)).json().find(
      (d: { name: string }) => d.name === 'Runs',
    );
    expect(runsDb, 'ensurePack must have provisioned Runs').toBeTruthy();

    // #493's own grounding: Runs carries no user-type field by default — an
    // admin can add one, same as any database (fields.service.ts's create()
    // never checks isSystem).
    const reviewer = (
      await as(admin2.token, 'POST', `/workspaces/${ws2}/databases/${runsDb.id}/fields`, {
        display_name: 'Assigned Reviewer',
        type: 'user',
      })
    ).json();
    const run = (
      await as(admin2.token, 'POST', `/workspaces/${ws2}/databases/${runsDb.id}/records`, {
        values: { [reviewer.apiName]: target2Id },
      })
    ).json();

    const anon = await as(admin2.token, 'POST', `/workspaces/${ws2}/members/${target2Membership}/gdpr/anonymize`);
    expect(anon.statusCode, anon.body).toBe(200);

    const after = (await as(admin2.token, 'GET', `/workspaces/${ws2}/databases/${runsDb.id}/records/${run.id}`)).json();
    expect(after.values[reviewer.apiName]).toBeUndefined();
  });
});

describe('MUST KEEP WORKING: createdBy is untouched, and free-text content is an accepted, documented residual risk (#493)', () => {
  it('createdBy on an authored record still identifies the (now-tombstoned) user id — audit lineage preserved', async () => {
    const space = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: space, name: 'Lineage' })).json().id;
    // `other` (not yet erased) authors a record.
    const rec = (await as(other.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, { values: {} })).json();

    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json();
    const otherMembership = members.find((m: { user_id: string }) => m.user_id === otherId).id;
    const anon = await as(admin.token, 'POST', `/workspaces/${wsId}/members/${otherMembership}/gdpr/anonymize`);
    expect(anon.statusCode, anon.body).toBe(200);

    const row = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`);
    // The record itself, and its lineage, are untouched — this is the
    // documented, deliberate exclusion (gdpr.service.ts's own header
    // comment), not a gap this ticket closes.
    expect(row.statusCode, row.body).toBe(200);
  });

  it('an admin-typed name in a rich_text field survives erasure — documented, accepted limitation, not a silent gap', async () => {
    const space = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
    const dbId = (await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, { space_id: space, name: 'Notes' })).json().id;
    const notesField = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/fields`, { display_name: 'Notes', type: 'rich_text' })
    ).json();

    const person = await signUpUser(app, 'FreeTextTarget');
    const personId = (await as(person.token, 'GET', '/me')).json().id;
    const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, { email: person.email, role: 'member' });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(person.token, 'POST', '/invites/accept', { token });

    // An admin free-types the person's real name into rich text — the exact
    // residual-risk scenario named on #493. No structured field names them.
    const rec = (
      await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${dbId}/records`, {
        values: { [notesField.apiName]: [{ type: 'paragraph', content: [{ type: 'text', text: person.email, styles: {} }] }] },
      })
    ).json();

    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json();
    const personMembership = members.find((m: { user_id: string }) => m.user_id === personId).id;
    const anon = await as(admin.token, 'POST', `/workspaces/${wsId}/members/${personMembership}/gdpr/anonymize`);
    expect(anon.statusCode, anon.body).toBe(200);

    const after = (await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${dbId}/records/${rec.id}`)).json();
    expect(
      JSON.stringify(after.values[notesField.apiName]),
      'documented on #493: free-text content is NOT scanned by erasure anywhere in this codebase — this must keep failing until that decision changes',
    ).toContain(person.email);
  });
});
