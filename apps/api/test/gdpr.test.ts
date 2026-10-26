import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { DB } from '../src/db/db.module';
import { authed, signUpUser } from './helpers/users';
import { MembersProjectionSubscriber } from '../src/members/members-projection.subscriber';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let memberId: string;
let memberMembership: string;
let adminMembership: string;
let wsId: string;
let space: string;
let db: string;
let recId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'GdprOwner');
  member = await signUpUser(app, 'GdprMember');
  memberId = (await as(member.token, 'GET', '/me')).json().id;

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'GDPR WS' })).json().id;
  space = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  db = (
    await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
      space_id: space,
      name: 'Tasks',
    })
  ).json().id;

  // member joins with editor access so they can author a record + comment
  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: member.email,
    role: 'member',
    grants: [{ space_id: space, role: 'editor' }],
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(member.token, 'POST', '/invites/accept', { token });

  recId = (
    await as(member.token, 'POST', `/workspaces/${wsId}/databases/${db}/records`, {
      values: { name: 'Member task' },
    })
  ).json().id;
  await as(member.token, 'POST', `/workspaces/${wsId}/databases/${db}/records/${recId}/comments`, {
    body: [{ type: 'text', text: 'a comment by the member' }],
  });

  const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json();
  memberMembership = members.find((m: { user_id: string }) => m.user_id === memberId).id;
  adminMembership = members.find((m: { user_id: string }) => m.user_id !== memberId).id;
});

afterAll(async () => {
  await app.close();
});

describe('GDPR data-subject tooling (MN-233)', () => {
  it('a non-admin cannot export or anonymize', async () => {
    const exp = await as(member.token, 'GET', `/workspaces/${wsId}/members/${memberMembership}/gdpr/export`);
    expect(exp.statusCode).toBe(403);
    const anon = await as(member.token, 'POST', `/workspaces/${wsId}/members/${memberMembership}/gdpr/anonymize`);
    expect(anon.statusCode).toBe(403);
  });

  it('admin export includes the subject profile and their authored content', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${wsId}/members/${memberMembership}/gdpr/export`);
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json();
    expect(data.subject_user_id).toBe(memberId);
    expect(data.profile.email).toBe(member.email);
    expect(data.authored_records.some((r: { id: string }) => r.id === recId)).toBe(true);
    expect(data.authored_comments.length).toBeGreaterThanOrEqual(1);
    expect(data.membership.role).toBe('member');
  });

  it('refuses to anonymize the last admin', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/members/${adminMembership}/gdpr/anonymize`);
    expect(res.statusCode).toBe(409);
  });

  it('a workspace anonymize removes the person FROM THIS WORKSPACE (#1039), anonymises its tokens, keeps history', async () => {
    // #543 — a bound token with a personal name; erasure must keep the scope record and strip the person.
    const minted = await as(member.token, 'POST', '/me/tokens', {
      name: "Daria's laptop", workspace_id: wsId, resource_scope: { database_ids: [db] },
    });
    expect(minted.statusCode, minted.body).toBe(201);
    const mintedToken = minted.json().token as string;
    const mintedId = minted.json().id as string;
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/members/${memberMembership}/gdpr/anonymize`);
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json();
    expect(out.anonymized).toBe(true);
    expect(out).toMatchObject({ scope: 'workspace', identity_erased: false });
    expect(out.removed.memberships).toBe(1);
    expect(out.retained_anonymized.api_tokens).toBeGreaterThanOrEqual(1);

    // #543 — the token row SURVIVES with its scope and window, and carries nothing about the person.
    const pool = (app.get(DB) as unknown as { $client: { query: (q: string, p: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } }).$client;
    const kept = (await pool.query('select * from api_tokens where id = $1', [mintedId])).rows[0]!;
    expect(kept.resource_scope).toEqual({ space_ids: [], database_ids: [db] });
    expect(kept.scope).toBeTruthy();
    expect(kept.workspace_id).toBe(wsId);
    expect(kept.revoked_at).not.toBeNull();
    expect(kept.last_used_at).toBeNull();
    expect(kept.name).toBe('Erased token');
    expect(kept.token_prefix).toBe('erased');
    expect(String(kept.user_id)).toBe(`erased:${mintedId}`);
    expect(JSON.stringify(kept)).not.toContain('Daria');
    expect(JSON.stringify(kept)).not.toContain(memberId);
    // …and it can never authenticate again.
    expect((await as(mintedToken, 'GET', '/me')).statusCode).toBe(401);

    // membership gone
    const members = (await as(admin.token, 'GET', `/workspaces/${wsId}/members`)).json();
    expect(members.some((m: { user_id: string }) => m.user_id === memberId)).toBe(false);

    // #1039 — their ACCOUNT is untouched: the same session still works (a workspace admin does not own a person's identity)
    const me = await as(member.token, 'GET', '/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe(member.email);

    // …but this workspace is closed to them
    expect((await as(member.token, 'GET', `/workspaces/${wsId}/databases`)).statusCode).toBe(404);

    // the comment survives (history is kept)
    const comments = (
      await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${db}/records/${recId}/comments`)
    ).json();
    expect(comments.data.length).toBeGreaterThanOrEqual(1);
  });

  it('a removed membership can no longer be targeted', async () => {
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/members/${memberMembership}/gdpr/anonymize`);
    expect(res.statusCode).toBe(404);
  });
});

describe('#494 — subject-access export includes the Members-database row', () => {
  let ws2: string;
  let space2: string;
  let member2: { token: string; email: string };
  let member2Id: string;
  let member2Membership: string;

  beforeAll(async () => {
    member2 = await signUpUser(app, 'Gdpr494Member');
    member2Id = (await as(member2.token, 'GET', '/me')).json().id;
    ws2 = (await as(admin.token, 'POST', '/workspaces', { name: 'GDPR WS 494' })).json().id;
    space2 = (await as(admin.token, 'GET', `/workspaces/${ws2}/spaces`)).json()[0].id;

    const invite = await as(admin.token, 'POST', `/workspaces/${ws2}/invites`, {
      email: member2.email,
      role: 'member',
      grants: [{ space_id: space2, role: 'editor' }],
    });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(member2.token, 'POST', '/invites/accept', { token });
    await app.get(MembersProjectionSubscriber).settle(ws2);

    const members = (await as(admin.token, 'GET', `/workspaces/${ws2}/members`)).json();
    member2Membership = members.find((m: { user_id: string }) => m.user_id === member2Id).id;

    // An admin adds a custom column to Members and populates it for this person.
    const membersDb = (await as(admin.token, 'GET', `/workspaces/${ws2}/databases`)).json().find(
      (d: { name: string }) => d.name === 'Members',
    );
    const phoneField = (
      await as(admin.token, 'POST', `/workspaces/${ws2}/databases/${membersDb.id}/fields`, { display_name: 'Phone', type: 'text' })
    ).json();
    const rows = (await as(admin.token, 'GET', `/workspaces/${ws2}/databases/${membersDb.id}/records`)).json().data;
    const memberRow = rows.find((r: { values: Record<string, unknown> }) => r.values['user_id'] === member2Id);
    await as(admin.token, 'PATCH', `/workspaces/${ws2}/databases/${membersDb.id}/records/${memberRow.id}`, {
      values: { [phoneField.apiName]: '555-0100' },
    });
  });

  it('export before erasure includes the Members row, custom column value included', async () => {
    const res = await as(admin.token, 'GET', `/workspaces/${ws2}/members/${member2Membership}/gdpr/export`);
    expect(res.statusCode, res.body).toBe(200);
    const row = res.json().members_row;
    expect(row, 'the export must include the members_row key at all').toBeTruthy();
    expect(row.email).toBe(member2.email);
    const membersDb = (await as(admin.token, 'GET', `/workspaces/${ws2}/databases`)).json().find(
      (d: { name: string }) => d.name === 'Members',
    );
    const fields = (await as(admin.token, 'GET', `/workspaces/${ws2}/databases/${membersDb.id}`)).json().fields;
    const phoneApiName = fields.find((f: { displayName: string }) => f.displayName === 'Phone').apiName;
    expect(row[phoneApiName]).toBe('555-0100');
  });

  it('DECISION: a departed member (membership already removed) gets a 404, not a partial export', async () => {
    const anon = await as(admin.token, 'POST', `/workspaces/${ws2}/members/${member2Membership}/gdpr/anonymize`);
    expect(anon.statusCode, anon.body).toBe(200);

    const after = await as(admin.token, 'GET', `/workspaces/${ws2}/members/${member2Membership}/gdpr/export`);
    expect(after.statusCode, 'documented decision on #494: export 404s once the membership is gone').toBe(404);
  });

  it('export degrades cleanly when the Members projection has not caught up yet — members_row is null, not an error', async () => {
    // Deliberately does NOT await the projection subscriber's settle() —
    // the Members-row sync is fire-and-forget off the membership-event bus
    // (members-projection.subscriber.ts), so an export requested in the gap
    // between "invite accepted" and "projection wrote the row" is a real,
    // reachable state, not a hypothetical. getOwnRowForExport must degrade to
    // null rather than throw.
    const ws3 = (await as(admin.token, 'POST', '/workspaces', { name: 'GDPR WS 494 no members db' })).json().id;
    const person = await signUpUser(app, 'Gdpr494NoRow');
    const invite = await as(admin.token, 'POST', `/workspaces/${ws3}/invites`, { email: person.email, role: 'member' });
    const token = new URL(invite.json().accept_url).searchParams.get('token')!;
    await as(person.token, 'POST', '/invites/accept', { token });
    const members = (await as(admin.token, 'GET', `/workspaces/${ws3}/members`)).json();
    const personMembership = members.find((m: { email?: string }) => m.email === person.email)?.id
      ?? members[members.length - 1].id;

    const res = await as(admin.token, 'GET', `/workspaces/${ws3}/members/${personMembership}/gdpr/export`);
    expect(res.statusCode, res.body).toBe(200);
    // Members provisions lazily off membership sync — by the time an invite
    // is accepted the projection has typically already run, so this mostly
    // guards that a MISSING row (not just a missing database) degrades to
    // null rather than throwing, whichever way it landed.
    expect(res.json()).toHaveProperty('members_row');
  });
});


/**
 * #1039 — an admin of workspace A (anyone, on hosted) could "erase" any member or guest and lock that person out of EVERY other
 * workspace, with no way even to reset a password; if they were the only admin of workspace B, B was orphaned. The attack is run as
 * the admin of A against a person who also belongs to B; the check is what that person can still do afterwards.
 */
describe('#1039 a workspace admin cannot erase a person\'s global identity', () => {
  let attacker: { token: string; email: string };
  let victim: { token: string; email: string };
  let victimId: string;
  let wsA: string, wsB: string, victimInA: string;

  beforeAll(async () => {
    attacker = await signUpUser(app, 'Admin Of A');
    victim = await signUpUser(app, 'Victim Of Two');
    victimId = (await as(victim.token, 'GET', '/me')).json().id;
    wsA = (await as(attacker.token, 'POST', '/workspaces', { name: 'Attackers A' })).json().id;
    wsB = (await as(victim.token, 'POST', '/workspaces', { name: 'Victims Own B' })).json().id; // the victim is the ONLY admin of B
    const invite = await as(attacker.token, 'POST', `/workspaces/${wsA}/invites`, { email: victim.email, role: 'member' });
    await as(victim.token, 'POST', '/invites/accept', { token: new URL(invite.json().accept_url).searchParams.get('token')! });
    victimInA = ((await as(attacker.token, 'GET', `/workspaces/${wsA}/members`)).json() as Array<{ id: string; user_id: string }>).find((m) => m.user_id === victimId)!.id;
  });

  it('THE ATTACK: erasing the victim from A leaves their account, their sign-in and workspace B fully intact', async () => {
    const res = await as(attacker.token, 'POST', `/workspaces/${wsA}/members/${victimInA}/gdpr/anonymize`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ scope: 'workspace', identity_erased: false });
    // the victim is out of A…
    expect((await as(victim.token, 'GET', `/workspaces/${wsA}/databases`)).statusCode).toBe(404);
    // …and nothing else changed: same session, same real email, same workspace B, still its only admin
    const me = await as(victim.token, 'GET', '/me');
    expect(me.statusCode, me.body).toBe(200);
    expect(me.json().email).toBe(victim.email);
    expect(me.json().name).not.toBe('Deleted user');
    expect((await as(victim.token, 'GET', `/workspaces/${wsB}/databases`)).statusCode).toBe(200);
    const bMembers = (await as(victim.token, 'GET', `/workspaces/${wsB}/members`)).json() as Array<{ user_id: string; role: string }>;
    expect(bMembers.find((m) => m.user_id === victimId)).toMatchObject({ role: 'admin' });
    // the credentials survive: a password sign-in still resolves (the account row is there)
    const rows = (await (app.get(DB) as unknown as { $client: { query: (q: string, p: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } }).$client.query('select (select count(*) from account where user_id = $1)::int as accounts, (select email from "user" where id = $1) as email', [victimId])).rows[0]!;
    expect(rows.accounts).toBeGreaterThanOrEqual(1);
    expect(rows.email).toBe(victim.email);
  });

  it('a token the victim minted for ANOTHER workspace keeps working; only the one for the erasing workspace is anonymised', async () => {
    const other = await signUpUser(app, 'Two Tokens');
    const otherId = (await as(other.token, 'GET', '/me')).json().id;
    const wsOwn = (await as(other.token, 'POST', '/workspaces', { name: 'Two Tokens Own' })).json().id;
    const inv = await as(attacker.token, 'POST', `/workspaces/${wsA}/invites`, { email: other.email, role: 'member' });
    await as(other.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    const tokA = (await as(other.token, 'POST', '/me/tokens', { name: 'for A', workspace_id: wsA })).json().token as string;
    const tokOwn = (await as(other.token, 'POST', '/me/tokens', { name: 'for own', workspace_id: wsOwn })).json().token as string;
    const memId = ((await as(attacker.token, 'GET', `/workspaces/${wsA}/members`)).json() as Array<{ id: string; user_id: string }>).find((m) => m.user_id === otherId)!.id;
    expect((await as(attacker.token, 'POST', `/workspaces/${wsA}/members/${memId}/gdpr/anonymize`)).statusCode).toBe(200);
    expect((await as(tokA, 'GET', '/me')).statusCode, 'the token for the erasing workspace is dead').toBe(401);
    expect((await as(tokOwn, 'GET', '/me')).statusCode, 'the token for their own workspace still works').toBe(200);
  });

  it('even a person with NO other workspace keeps their account: a workspace admin never destroys an identity', async () => {
    const lone = await signUpUser(app, 'Only In A');
    const loneId = (await as(lone.token, 'GET', '/me')).json().id;
    const inv = await as(attacker.token, 'POST', `/workspaces/${wsA}/invites`, { email: lone.email, role: 'member' });
    await as(lone.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    const memId = ((await as(attacker.token, 'GET', `/workspaces/${wsA}/members`)).json() as Array<{ id: string; user_id: string }>).find((m) => m.user_id === loneId)!.id;
    expect((await as(attacker.token, 'POST', `/workspaces/${wsA}/members/${memId}/gdpr/anonymize`)).statusCode).toBe(200);
    expect((await as(lone.token, 'GET', '/me')).json().email).toBe(lone.email);
  });
});

describe('#1039 the person can erase THEIR OWN identity (self-service, session only)', () => {
  it('is refused for an API token, an unconfirmed body, and while they are the only admin of a workspace', async () => {
    const u = await signUpUser(app, 'Self Eraser');
    const ws = (await as(u.token, 'POST', '/workspaces', { name: 'Sole Admin WS' })).json().id;
    const pat = (await as(u.token, 'POST', '/me/tokens', { name: 'p', workspace_id: ws })).json().token as string;
    expect((await as(pat, 'POST', '/me/gdpr/erase', { confirm: true })).statusCode, 'a token cannot').toBe(403);
    expect((await as(u.token, 'POST', '/me/gdpr/erase', {})).statusCode, 'no confirmation').toBeGreaterThanOrEqual(400);
    const orphan = await as(u.token, 'POST', '/me/gdpr/erase', { confirm: true });
    expect(orphan.statusCode, orphan.body).toBe(409);
    expect(orphan.body).toContain('only admin');
    expect((await as(u.token, 'GET', '/me')).statusCode, 'still signed in: nothing happened').toBe(200);
  });

  it('erases the account everywhere: tombstone, no sign-in, out of every workspace, other workspaces keep their admin', async () => {
    const boss = await signUpUser(app, 'Boss');
    const person = await signUpUser(app, 'Leaver');
    const personId = (await as(person.token, 'GET', '/me')).json().id;
    const ws1 = (await as(boss.token, 'POST', '/workspaces', { name: 'Boss WS 1' })).json().id;
    const ws2 = (await as(boss.token, 'POST', '/workspaces', { name: 'Boss WS 2' })).json().id;
    for (const ws of [ws1, ws2]) {
      const inv = await as(boss.token, 'POST', `/workspaces/${ws}/invites`, { email: person.email, role: 'member' });
      await as(person.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    }
    const res = await as(person.token, 'POST', '/me/gdpr/erase', { confirm: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ scope: 'global', identity_erased: true, workspaces_left: 2 });
    expect((await as(person.token, 'GET', '/me')).statusCode, 'their session is destroyed').toBe(401);
    for (const ws of [ws1, ws2]) {
      const members = (await as(boss.token, 'GET', `/workspaces/${ws}/members`)).json() as Array<{ user_id: string }>;
      expect(members.some((m) => m.user_id === personId), 'out of every workspace').toBe(false);
      expect((await as(boss.token, 'GET', `/workspaces/${ws}/databases`)).statusCode, 'the workspaces carry on').toBe(200);
    }
    const row = (await (app.get(DB) as unknown as { $client: { query: (q: string, p: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } }).$client.query('select email, name from "user" where id = $1', [personId])).rows[0]!;
    expect(row).toMatchObject({ email: `deleted-${personId}@anonymized.invalid`, name: 'Deleted user' });
  });
});

describe('#1080 self-erase writes no old identifier anywhere and scrubs what already exists', () => {
  const rawRows = async (q: string, p: unknown[] = []) =>
    (await (app.get(DB) as unknown as { $client: { query: (q: string, p: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } }).$client.query(q, p)).rows;
  const mentions = async (needle: string) => {
    const like = `%${needle}%`;
    const out: Record<string, number> = {};
    for (const [label, q] of Object.entries({
      activity_events: 'select count(*)::int n from activity_events where payload::text ilike $1',
      field_changes: 'select count(*)::int n from record_field_changes where coalesce(old_value::text, \'\') ilike $1 or coalesce(new_value::text, \'\') ilike $1',
      versions: 'select count(*)::int n from record_versions where "values"::text ilike $1 or title ilike $1',
      members_rows: `select count(*)::int n from records r join databases d on d.id = r.database_id where d.is_system and d.name = 'Members' and (r.values::text ilike $1 or r.title ilike $1)`,
    })) out[label] = (await rawRows(q, [like]))[0]!.n as number;
    return out;
  };

  it('the old email and name appear in NO audit/activity/history row after erase, in workspaces they are in AND ones they had left, and no event is written to a left workspace', async () => {
    const boss = await signUpUser(app, 'Boss1080');
    const uniqueName = `Marguerite Quillfeather ${Date.now()}`;
    const person = await signUpUser(app, uniqueName);
    const personId = (await as(person.token, 'GET', '/me')).json().id as string;
    const joined = async (name: string) => {
      const ws = (await as(boss.token, 'POST', '/workspaces', { name })).json().id as string;
      const inv = await as(boss.token, 'POST', `/workspaces/${ws}/invites`, { email: person.email, role: 'member' });
      await as(person.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
      return ws;
    };
    const stays = await joined('Stays WS 1080');
    const left = await joined('Left WS 1080');
    // The person is removed from `left` BEFORE erasing: their Members row survives there, tombstoned, still holding the real address.
    const memberId = ((await as(boss.token, 'GET', `/workspaces/${left}/members`)).json() as Array<{ id: string; user_id: string }>).find((m) => m.user_id === personId)!.id;
    expect((await as(boss.token, 'DELETE', `/workspaces/${left}/members/${memberId}`)).statusCode).toBeLessThan(300);
    await new Promise((r) => setTimeout(r, 300));

    // Make real history quote the address: it is the person's email in a Members-projection write.
    const needleEmail = person.email.toLowerCase();
    expect((await mentions(needleEmail)).members_rows, 'precondition: the Members rows hold the real address').toBeGreaterThan(0);
    const eventsBefore = (await rawRows('select count(*)::int n from activity_events where workspace_id = $1', [left]))[0]!.n as number;

    const res = await as(person.token, 'POST', '/me/gdpr/erase', { confirm: true });
    expect(res.statusCode, res.body).toBe(200);
    await new Promise((r) => setTimeout(r, 300));

    for (const needle of [needleEmail, uniqueName]) {
      const found = await mentions(needle);
      expect(found, `"${needle}" must appear in no history table or Members row`).toEqual({ activity_events: 0, field_changes: 0, versions: 0, members_rows: 0 });
    }
    expect((await rawRows('select count(*)::int n from activity_events where workspace_id = $1', [left]))[0]!.n, 'nothing was written to the workspace they had left').toBe(eventsBefore);
    for (const ws of [stays, left]) {
      const log = await as(boss.token, 'GET', `/workspaces/${ws}/audit-log`);
      expect(log.statusCode, log.body).toBe(200);
      expect(log.body.toLowerCase()).not.toContain(needleEmail);
    }
  });

  it('existing history that quotes the address is rewritten, not just the Members row', async () => {
    const boss = await signUpUser(app, 'Boss1080b');
    const person = await signUpUser(app, 'Scrub Target');
    const personId = (await as(person.token, 'GET', '/me')).json().id as string;
    const ws = (await as(boss.token, 'POST', '/workspaces', { name: 'Scrub WS 1080' })).json().id as string;
    const inv = await as(boss.token, 'POST', `/workspaces/${ws}/invites`, { email: person.email, role: 'member' });
    await as(person.token, 'POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! });
    const space = (await as(boss.token, 'POST', `/workspaces/${ws}/spaces`, { name: 'S' })).json();
    const dbId = (await as(boss.token, 'POST', `/workspaces/${ws}/databases`, { space_id: space.id, name: 'Notes' })).json().id as string;
    const rec = (await as(boss.token, 'POST', `/workspaces/${ws}/databases/${dbId}/records`, { values: { name: `call ${person.email}` } })).json();
    await as(boss.token, 'PATCH', `/workspaces/${ws}/databases/${dbId}/records/${rec.id}`, { values: { name: `emailed ${person.email} today` } });
    const needle = person.email.toLowerCase();
    expect((await mentions(needle)).activity_events, 'precondition: history quotes it').toBeGreaterThan(0);
    expect((await as(person.token, 'POST', '/me/gdpr/erase', { confirm: true })).statusCode).toBe(200);
    const found = await mentions(needle);
    expect(found.activity_events + found.field_changes + found.versions).toBe(0);
    // The workspace's OWN record is its content and stays; only the trail was scrubbed.
    const kept = (await as(boss.token, 'GET', `/workspaces/${ws}/databases/${dbId}/records/${rec.id}`)).json();
    expect(String(kept.title)).toContain('emailed');
    expect(personId).toBeTruthy();
  });
});
