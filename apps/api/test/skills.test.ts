import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { eq } from 'drizzle-orm';
import { DB } from '../src/db/db.module';
import type { Db } from '../src/db/client';
import { user as userTable } from '../src/db/schema';

let app: NestFastifyApplication;
let owner: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;

async function inject(method: string, url: string, payload?: unknown, token = owner.token) {
  return app.inject({
    method: method as never,
    url: `/api/v1${url}`,
    headers: authed(token),
    payload: payload as never,
  });
}

/** #867: agents may publish to the workspace BY DEFAULT; the tests of the publish gate switch it OFF. */
const agentPublishing = (on: boolean) => inject('PATCH', `/workspaces/${wsId}`, { agents_may_publish_skills: on });

const baseSkill = {
  name: 'Lead triage reply drafter',
  description: 'Drafts a first-touch reply for a new lead.',
  when_to_use: 'When a new lead record needs a fast draft reply.',
  instructions: 'Read the lead, draft a short friendly reply, never invent pricing.',
  examples: [{ input: 'Lead asks about pricing', output: 'Happy to walk you through pricing!' }],
};

beforeAll(async () => {
  app = await createTestApp();
  owner = await signUpUser(app, 'SkillOwner');
  member = await signUpUser(app, 'SkillMember');
  wsId = (await inject('POST', '/workspaces', { name: 'Skills WS' })).json().id;

  const invite = await inject('POST', `/workspaces/${wsId}/invites`, {
    email: member.email,
    role: 'member',
  });
  const inviteToken = new URL(invite.json().accept_url).searchParams.get('token')!;
  const accepted = await inject('POST', '/invites/accept', { token: inviteToken }, member.token);
  if (accepted.statusCode >= 300) throw new Error(`member invite failed: ${accepted.body}`);
});

afterAll(async () => {
  await app.close();
});

describe('#841 — allowed_tools is retired from the whole surface; admins read every skill', () => {
  it('authoring with allowed_tools is a clear 422, on create AND update (not a silent discard)', async () => {
    const created = await inject('POST', `/workspaces/${wsId}/skills`, { ...baseSkill, name: 'No tools please', allowed_tools: ['records.read'] });
    expect(created.statusCode, created.body).toBe(422);
    expect(created.body).toMatch(/allowed_tools/);
    expect(created.body).toMatch(/no longer accepted/);

    const ok = await inject('POST', `/workspaces/${wsId}/skills`, { ...baseSkill, name: 'No tools, fine' });
    expect(ok.statusCode, ok.body).toBe(201);
    const patched = await inject('PATCH', `/workspaces/${wsId}/skills/${ok.json().id}`, { allowed_tools: ['x'] });
    expect(patched.statusCode, patched.body).toBe(422);
  });

  it('is in NO response body: create, get, list, templates, and all three exports', async () => {
    const made = await inject('POST', `/workspaces/${wsId}/skills`, { ...baseSkill, name: 'Body check skill' });
    const id = made.json().id;
    const bodies = [
      made.body,
      (await inject('GET', `/workspaces/${wsId}/skills/${id}`)).body,
      (await inject('GET', `/workspaces/${wsId}/skills`)).body,
      (await inject('GET', `/workspaces/${wsId}/skills/templates`)).body,
      (await inject('GET', `/workspaces/${wsId}/skills/${id}/export?format=markdown`)).body,
      (await inject('GET', `/workspaces/${wsId}/skills/${id}/export?format=claude_skill`)).body,
      (await inject('GET', `/workspaces/${wsId}/skills/${id}/export?format=chatgpt`)).body,
      (await inject('POST', `/workspaces/${wsId}/skills/${id}/run`)).body,
    ];
    for (const [i, b] of bodies.entries()) expect(b, `response #${i}`).not.toMatch(/allowed[_ -]tools|Allowed tools/i);
  });

  it('a workspace ADMIN reads every skill including another member\'s personal one; a member still cannot', async () => {
    const theirs = await inject('POST', `/workspaces/${wsId}/skills`, { ...baseSkill, name: 'Only-me skill of a member', visibility: 'personal' }, member.token);
    expect(theirs.statusCode, theirs.body).toBe(201);
    const id = theirs.json().id;
    // The admin (owner) sees it in the list and by id, but does not own it.
    const list = await inject('GET', `/workspaces/${wsId}/skills`);
    expect(list.json().data.map((x: { id: string }) => x.id)).toContain(id);
    const got = await inject('GET', `/workspaces/${wsId}/skills/${id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json().editable).toBe(false);
    expect((await inject('PATCH', `/workspaces/${wsId}/skills/${id}`, { description: 'x' })).statusCode).toBe(403);
    // The control: another MEMBER still gets a 404 for it.
    const other = await signUpUser(app, 'SkillOther');
    const inv = await inject('POST', `/workspaces/${wsId}/invites`, { email: other.email, role: 'member' });
    await inject('POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! }, other.token);
    expect((await inject('GET', `/workspaces/${wsId}/skills/${id}`, undefined, other.token)).statusCode).toBe(404);
  });
});

describe('#832 — a skill a PERSON creates is visible to the workspace by default', () => {
  const base = { ...baseSkill, name: 'Default-visibility skill' };

  it('create with NO visibility, as a person: shared, and a teammate sees it and can resolve it', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/skills`, base);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().visibility).toBe('shared');
    const id = res.json().id;

    const seen = await inject('GET', `/workspaces/${wsId}/skills`, undefined, member.token);
    expect(seen.json().data.map((s: { id: string }) => s.id)).toContain(id);
    const got = await inject('GET', `/workspaces/${wsId}/skills/${id}`, undefined, member.token);
    expect(got.statusCode).toBe(200);
    expect(got.json().instructions).toBe(baseSkill.instructions);
    // The teammate can run it (the resolve + bookkeeping half of "my skill, your AI").
    const ran = await inject('POST', `/workspaces/${wsId}/skills/${id}/run`, undefined, member.token);
    expect(ran.statusCode, ran.body).toBeLessThan(300);
  });

  it('an EXPLICIT personal is still honoured, and stays invisible to a teammate', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/skills`, { ...base, name: 'Explicitly mine', visibility: 'personal' });
    expect(res.json().visibility).toBe('personal');
    const seen = await inject('GET', `/workspaces/${wsId}/skills`, undefined, member.token);
    expect(seen.json().data.map((s: { id: string }) => s.id)).not.toContain(res.json().id);
  });
});

describe('skills framework (#40)', () => {
  it('lists the starter templates, including a blank scaffold', async () => {
    const res = await inject('GET', `/workspaces/${wsId}/skills/templates`);
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((t: { id: string }) => t.id);
    expect(ids).toContain('blank');
    expect(ids).toContain('lead-triage-reply');
  });

  it('rejects create with a missing required field (422)', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/skills`, {
      description: 'no name or instructions',
    });
    expect(res.statusCode).toBe(422);
  });

  it('creates a personal skill visible only to its owner', async () => {
    const create = await inject('POST', `/workspaces/${wsId}/skills`, {
      ...baseSkill,
      name: 'Personal one',
      visibility: 'personal',
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.visibility).toBe('personal');
    expect(body.editable).toBe(true);
    const id = body.id;

    const ownerList = await inject('GET', `/workspaces/${wsId}/skills`);
    expect(ownerList.json().data.map((s: { id: string }) => s.id)).toContain(id);

    const memberList = await inject('GET', `/workspaces/${wsId}/skills`, undefined, member.token);
    expect(memberList.json().data.map((s: { id: string }) => s.id)).not.toContain(id);

    const memberGet = await inject('GET', `/workspaces/${wsId}/skills/${id}`, undefined, member.token);
    expect(memberGet.statusCode).toBe(404);
  });

  it('creates a shared skill any member can see, run, and export — but not edit', async () => {
    const create = await inject('POST', `/workspaces/${wsId}/skills`, {
      ...baseSkill,
      name: 'Team-shared one',
      visibility: 'shared',
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    const memberGet = await inject('GET', `/workspaces/${wsId}/skills/${id}`, undefined, member.token);
    expect(memberGet.statusCode).toBe(200);
    expect(memberGet.json().editable).toBe(false);

    const memberPatch = await inject(
      'PATCH',
      `/workspaces/${wsId}/skills/${id}`,
      { name: 'hijacked' },
      member.token,
    );
    expect(memberPatch.statusCode).toBe(403);

    const memberDelete = await inject('DELETE', `/workspaces/${wsId}/skills/${id}`, undefined, member.token);
    expect(memberDelete.statusCode).toBe(403);

    const run = await inject('POST', `/workspaces/${wsId}/skills/${id}/run`, undefined, member.token);
    expect(run.statusCode).toBe(201);
    const runBody = run.json();
    expect(runBody.run_class).toBe('non_ai');
    expect(runBody.steps.length).toBeGreaterThan(0);
    expect(runBody.steps.map((s: { tool: string }) => s.tool)).toContain('skill.instructions');

    const afterRun = await inject('GET', `/workspaces/${wsId}/skills/${id}`, undefined, member.token);
    expect(afterRun.json().last_run_status).toBe('ok');
    expect(afterRun.json().last_run_at).not.toBeNull();
  });

  it('exports a skill in all three portable formats', async () => {
    const create = await inject('POST', `/workspaces/${wsId}/skills`, {
      ...baseSkill,
      name: 'Exportable Skill',
      visibility: 'shared',
    });
    const id = create.json().id;

    const md = await inject('GET', `/workspaces/${wsId}/skills/${id}/export?format=markdown`);
    expect(md.statusCode).toBe(200);
    expect(md.json().filename).toBe('exportable-skill.md');
    expect(md.json().content).toContain('# Exportable Skill');
    expect(md.json().content).toContain(baseSkill.instructions);

    const claude = await inject('GET', `/workspaces/${wsId}/skills/${id}/export?format=claude_skill`);
    expect(claude.statusCode).toBe(200);
    expect(claude.json().filename).toBe('SKILL.md');
    expect(claude.json().content).toMatch(/^---\nname: exportable-skill\ndescription: /);

    const chatgpt = await inject('GET', `/workspaces/${wsId}/skills/${id}/export?format=chatgpt`);
    expect(chatgpt.statusCode).toBe(200);
    expect(chatgpt.json().content).toContain('Custom instructions');

    const bad = await inject('GET', `/workspaces/${wsId}/skills/${id}/export?format=nope`);
    expect(bad.statusCode).toBe(400);
  });

  it('lets the owner edit and delete their own skill', async () => {
    const create = await inject('POST', `/workspaces/${wsId}/skills`, {
      ...baseSkill,
      name: 'Editable',
      visibility: 'personal',
    });
    const id = create.json().id;

    const patch = await inject('PATCH', `/workspaces/${wsId}/skills/${id}`, { description: 'updated' });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().description).toBe('updated');

    const del = await inject('DELETE', `/workspaces/${wsId}/skills/${id}`);
    expect(del.statusCode).toBe(200);

    const get = await inject('GET', `/workspaces/${wsId}/skills/${id}`);
    expect(get.statusCode).toBe(404);
  });
});

/**
 * #442 — a skill is instructions a future agent will follow, so two things have
 * to be true about one written over the API: the record of WHO wrote it cannot
 * be set by the writer, and an agent cannot publish instructions to other
 * people's agents.
 *
 * Both are asserted against a real PAT rather than a mocked auth context —
 * `auth.source` is derived in AuthGuard, so a unit test of the service would
 * prove the gate works while leaving the derivation untested, which is the half
 * that actually decides the value.
 */
describe('#442 — authorship is derived, and an agent cannot publish a skill', () => {
  let pat: string;

  beforeAll(async () => {
    const res = await inject('POST', '/me/tokens', { name: 'skill-author', workspace_id: wsId });
    pat = res.json().token;
  });

  it('records a session-authored skill as human', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/skills`, { ...baseSkill, name: 'Typed by a person' });
    expect(res.statusCode).toBe(201);
    expect(res.json().source).toBe('human');
  });

  it('records a PAT-authored skill as mcp — and ignores a body that claims otherwise', async () => {
    // The `source: 'human'` in the payload is the attack: provenance a caller can
    // declare is not provenance. It must be dropped, not honoured.
    const res = await inject(
      'POST',
      `/workspaces/${wsId}/skills`,
      { ...baseSkill, name: 'Written by an agent', source: 'human' },
      pat,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().source).toBe('mcp');
  });

  it('with AI publishing switched OFF: refuses to create a SHARED skill over a token, naming why', async () => {
    expect((await agentPublishing(false)).statusCode).toBe(200);
    const res = await inject(
      'POST',
      `/workspaces/${wsId}/skills`,
      { ...baseSkill, name: 'Agent tries to publish', visibility: 'shared' },
      pat,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message ?? res.body).toMatch(/personal/i);
    await agentPublishing(true);
  });

  it('with AI publishing switched OFF: refuses to PROMOTE an existing skill to shared over a token', async () => {
    // Without this the create-side rule is one PATCH away from decorative.
    expect((await agentPublishing(false)).statusCode).toBe(200);
    const created = await inject('POST', `/workspaces/${wsId}/skills`, { ...baseSkill, name: 'Promote me' }, pat);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const promote = await inject('PATCH', `/workspaces/${wsId}/skills/${id}`, { visibility: 'shared' }, pat);
    expect(promote.statusCode).toBe(403);

    const after = await inject('GET', `/workspaces/${wsId}/skills/${id}`, undefined, pat);
    expect(after.json().visibility).toBe('personal');
    await agentPublishing(true);
  });

  it('still lets an agent edit its own skill, and a HUMAN promote it', async () => {
    // The gate is about publishing, not about writing — an agent that cannot
    // refine its own instructions would make the whole feature pointless.
    const created = await inject('POST', `/workspaces/${wsId}/skills`, { ...baseSkill, name: 'Refine me' }, pat);
    const id = created.json().id;

    const edit = await inject('PATCH', `/workspaces/${wsId}/skills/${id}`, { instructions: 'Sharper steps.' }, pat);
    expect(edit.statusCode).toBe(200);
    expect(edit.json().instructions).toBe('Sharper steps.');

    // Same owner, session auth — the person reads it and publishes it.
    const promote = await inject('PATCH', `/workspaces/${wsId}/skills/${id}`, { visibility: 'shared' });
    expect(promote.statusCode).toBe(200);
    expect(promote.json().visibility).toBe('shared');
    // Promotion does not rewrite history: it was still written by an agent.
    expect(promote.json().source).toBe('mcp');
  });
});

describe('#841 — POST /skills/import: the report comes first', () => {
  const FOREIGN = `---
name: pdf-forms
description: Fill in PDF forms.
license: MIT
allowed-tools: Read Write
---

# PDF forms

1. Read the form.
2. Fill it.
`;

  it('PREVIEW by default: returns the KEPT/DROPPED report and writes NOTHING', async () => {
    const before = (await inject('GET', `/workspaces/${wsId}/skills`)).json().data.length;
    const res = await inject('POST', `/workspaces/${wsId}/skills/import`, { content: FOREIGN });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.created).toBeNull();
    expect(body.importable).toBe(false); // no when_to_use in the file, and it is not invented
    expect(body.report.missing).toEqual(['when_to_use']);
    expect(body.report.dropped.map((d: { item: string }) => d.item)).toEqual(
      expect.arrayContaining(['frontmatter `license`', 'frontmatter `allowed-tools`']),
    );
    expect((await inject('GET', `/workspaces/${wsId}/skills`)).json().data.length).toBe(before);
  });

  it('create:true on a file that cannot become a skill is a 422 carrying the report, and creates nothing', async () => {
    const before = (await inject('GET', `/workspaces/${wsId}/skills`)).json().data.length;
    const res = await inject('POST', `/workspaces/${wsId}/skills/import`, { content: FOREIGN, create: true });
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error.details).toEqual([expect.objectContaining({ path: 'when_to_use' })]);
    expect((await inject('GET', `/workspaces/${wsId}/skills`)).json().data.length).toBe(before);
  });

  it('with the missing field supplied, create:true writes it, report included, and the dropped items are still listed', async () => {
    const res = await inject('POST', `/workspaces/${wsId}/skills/import`, {
      content: FOREIGN,
      create: true,
      overrides: { when_to_use: 'When asked to fill a PDF form.' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.created.name).toBe('pdf-forms');
    expect(body.created.instructions).toContain('1. Read the form.');
    expect(body.created.visibility).toBe('shared'); // a person's default (#832)
    expect(body.created).not.toHaveProperty('allowed_tools');
    expect(body.report.dropped.length).toBeGreaterThan(0);
  });

  it('an agent importing is bound by the same publish gate: with AI publishing OFF it cannot create it shared and gets personal by default; ON (the default) it gets shared', async () => {
    expect((await agentPublishing(false)).statusCode).toBe(200);
    const mint = await inject('POST', '/me/tokens', { name: 'import-test', workspace_id: wsId });
    const token = mint.json().token as string;
    const asAgent = (payload: unknown) => inject('POST', `/workspaces/${wsId}/skills/import`, payload, token);
    const content = '---\nname: agent-made\ndescription: d\n---\n\nSteps here.\n';
    const shared = await asAgent({ content, create: true, overrides: { when_to_use: 'w', visibility: 'shared' } });
    expect(shared.statusCode, shared.body).toBe(403);
    const dflt = await asAgent({ content, create: true, overrides: { when_to_use: 'w' } });
    expect(dflt.statusCode, dflt.body).toBe(201);
    expect(dflt.json().created.visibility).toBe('personal');
    expect(dflt.json().created.source).toBe('mcp');
    // ON again (the default for every workspace): the same call lands shared, still badged as the agent's.
    expect((await agentPublishing(true)).statusCode).toBe(200);
    const on = await asAgent({ content: content.replace('agent-made', 'agent-made-two'), create: true, overrides: { when_to_use: 'w' } });
    expect(on.statusCode, on.body).toBe(201);
    expect(on.json().created.visibility).toBe('shared');
    expect(on.json().created.source).toBe('mcp');
  });
});

/**
 * #841 — four visibility tiers. The two-account-plus-a-third shape is the point of the
 * `members` tier: A names B; B sees it; C does NOT; an admin still reads everything.
 */
describe('#841 — members, public and version', () => {
  let b: { token: string; email: string };
  let c: { token: string; email: string };
  let bId: string;
  let cId: string;
  let ownerId: string;

  async function joinAsMember(user: { token: string; email: string }) {
    const inv = await inject('POST', `/workspaces/${wsId}/invites`, { email: user.email, role: 'member' });
    const res = await inject('POST', '/invites/accept', { token: new URL(inv.json().accept_url).searchParams.get('token')! }, user.token);
    if (res.statusCode >= 300) throw new Error(res.body);
  }
  const ids = (res: { json: () => { data: Array<{ id: string }> } }) => res.json().data.map((s) => s.id);
  const base = (name: string) => ({ ...baseSkill, name });

  beforeAll(async () => {
    b = await signUpUser(app, 'SkillB');
    c = await signUpUser(app, 'SkillC');
    await joinAsMember(b);
    await joinAsMember(c);
    bId = (await inject('GET', '/me', undefined, b.token)).json().id;
    cId = (await inject('GET', '/me', undefined, c.token)).json().id;
    ownerId = (await inject('GET', '/me')).json().id;
  });

  it('A names B: B lists, reads and runs it; C does not see it at all; the admin does; neither sees the share list', async () => {
    const made = await inject('POST', `/workspaces/${wsId}/skills`, { ...base('Members-tier skill'), visibility: 'members', member_ids: [bId] }, member.token);
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json().id;
    expect(made.json().member_ids).toEqual([bId]); // the owner sees who it is shared with

    expect(ids(await inject('GET', `/workspaces/${wsId}/skills`, undefined, b.token))).toContain(id);
    const read = await inject('GET', `/workspaces/${wsId}/skills/${id}`, undefined, b.token);
    expect(read.statusCode).toBe(200);
    expect(read.json().editable).toBe(false);
    expect(read.json()).not.toHaveProperty('member_ids'); // B is named, but is not shown the audience
    expect((await inject('POST', `/workspaces/${wsId}/skills/${id}/run`, undefined, b.token)).statusCode).toBeLessThan(300);

    // C is a member of the same workspace and is NOT named: absent from the list, 404 by id and on run.
    expect(ids(await inject('GET', `/workspaces/${wsId}/skills`, undefined, c.token))).not.toContain(id);
    expect((await inject('GET', `/workspaces/${wsId}/skills/${id}`, undefined, c.token)).statusCode).toBe(404);
    expect((await inject('POST', `/workspaces/${wsId}/skills/${id}/run`, undefined, c.token)).statusCode).toBe(404);
    expect((await inject('GET', `/workspaces/${wsId}/skills/${id}/export?format=markdown`, undefined, c.token)).statusCode).toBe(404);

    // The admin reads it too, and sees the audience.
    const asAdmin = await inject('GET', `/workspaces/${wsId}/skills/${id}`);
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json().member_ids).toEqual([bId]);
  });

  it('naming someone outside the workspace is a 422 naming them; member_ids without the members tier is a 422', async () => {
    const stranger = await inject('POST', `/workspaces/${wsId}/skills`, { ...base('Stranger'), visibility: 'members', member_ids: ['not-a-member'] }, member.token);
    expect(stranger.statusCode, stranger.body).toBe(422);
    expect(stranger.json().error.details[0].message).toMatch(/not-a-member/);
    const wrongTier = await inject('POST', `/workspaces/${wsId}/skills`, { ...base('Wrong tier'), visibility: 'shared', member_ids: [bId] }, member.token);
    expect(wrongTier.statusCode, wrongTier.body).toBe(422);
  });

  it('replacing the audience takes effect at once, and leaving the members tier DROPS the list', async () => {
    const made = await inject('POST', `/workspaces/${wsId}/skills`, { ...base('Audience changes'), visibility: 'members', member_ids: [bId] }, member.token);
    const id = made.json().id;
    await inject('PATCH', `/workspaces/${wsId}/skills/${id}`, { member_ids: [cId] }, member.token);
    expect(ids(await inject('GET', `/workspaces/${wsId}/skills`, undefined, b.token))).not.toContain(id);
    expect(ids(await inject('GET', `/workspaces/${wsId}/skills`, undefined, c.token))).toContain(id);

    await inject('PATCH', `/workspaces/${wsId}/skills/${id}`, { visibility: 'shared' }, member.token);
    const back = await inject('PATCH', `/workspaces/${wsId}/skills/${id}`, { visibility: 'members' }, member.token);
    expect(back.json().member_ids, 'a re-share must not silently revive the old audience').toEqual([]);
    expect(ids(await inject('GET', `/workspaces/${wsId}/skills`, undefined, c.token))).not.toContain(id);
  });

  it('a skill share creates NO access grant: the grants table is untouched (AC3: the resolver never reads it)', async () => {
    const before = (await inject('GET', `/workspaces/${wsId}/grants`)).json();
    await inject('POST', `/workspaces/${wsId}/skills`, { ...base('No grant please'), visibility: 'members', member_ids: [bId, cId] }, member.token);
    expect((await inject('GET', `/workspaces/${wsId}/grants`)).json()).toEqual(before);
  });

  it('an agent credential may use `members` (naming people already in the workspace, #868); `public` is only a PROPOSAL a person approves (#867 AC3)', async () => {
    const mint = await inject('POST', '/me/tokens', { name: 'tiers-test', workspace_id: wsId });
    const token = mint.json().token as string;
    const asAgent = (method: string, url: string, payload?: unknown) => inject(method, url, payload, token);
    // `members` naming a real member works, and the set is the one named.
    const named = await asAgent('POST', `/workspaces/${wsId}/skills`, { ...base('Agent named'), visibility: 'members', member_ids: [bId] });
    expect(named.statusCode, named.body).toBe(201);
    expect(named.json().visibility).toBe('members');
    expect(named.json().member_ids).toEqual([bId]);
    // A non-member is refused with a reason (the same 422 a person gets), nothing created.
    const stranger = await asAgent('POST', `/workspaces/${wsId}/skills`, { ...base('Agent stranger'), visibility: 'members', member_ids: ['not-a-member'] });
    expect(stranger.statusCode, stranger.body).toBe(422);
    // `public`: not refused, not granted: a personal skill plus a pending approval, no link.
    const proposal = await asAgent('POST', `/workspaces/${wsId}/skills`, { ...base('Agent public'), visibility: 'public' });
    expect(proposal.statusCode, proposal.body).toBe(201);
    expect(proposal.json().visibility).toBe('personal');
    expect(proposal.json().pending_approval?.id).toBeTruthy();
    const mine = await asAgent('POST', `/workspaces/${wsId}/skills`, base('Agent default'));
    expect(mine.statusCode, mine.body).toBe(201);
    const toPublic = await asAgent('PATCH', `/workspaces/${wsId}/skills/${mine.json().id}`, { visibility: 'public' });
    expect(toPublic.statusCode, toPublic.body).toBe(200);
    expect(toPublic.json().visibility, 'unchanged until a person approves').toBe('shared');
    expect(toPublic.json().pending_approval?.id).toBeTruthy();
    // Control: the owner (a person) CAN do the same to the same skill, at once, with no approval.
    const direct = await inject('PATCH', `/workspaces/${wsId}/skills/${mine.json().id}`, { visibility: 'public' });
    expect(direct.statusCode).toBeLessThan(300);
    expect(direct.json().visibility).toBe('public');
  });

  it('public: a server-minted link, an unauthenticated read of portable fields only, and revocation that is immediate', async () => {
    const made = await inject('POST', `/workspaces/${wsId}/skills`, { ...base('Public skill'), visibility: 'public', public_token: 'client-chosen-token' });
    expect(made.statusCode, made.body).toBe(201);
    const token = made.json().public_token as string;
    expect(token).toBeTruthy();
    expect(token).not.toBe('client-chosen-token'); // never client-supplied

    const anon = await app.inject({ method: 'GET', url: `/api/v1/public/skills/${token}` }); // NO auth header
    expect(anon.statusCode, anon.body).toBe(200);
    expect(Object.keys(anon.json()).sort()).toEqual(['description', 'examples', 'instructions', 'name', 'updated_at', 'version', 'when_to_use']);

    // Only the owner and admins are shown the credential.
    const asMember = await inject('GET', `/workspaces/${wsId}/skills/${made.json().id}`, undefined, b.token);
    expect(asMember.json()).not.toHaveProperty('public_token');

    // Revoke: leaving `public` clears the token, and the link 404s at once, same as an unknown one.
    await inject('PATCH', `/workspaces/${wsId}/skills/${made.json().id}`, { visibility: 'shared' });
    expect((await app.inject({ method: 'GET', url: `/api/v1/public/skills/${token}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/public/skills/never-existed' })).statusCode).toBe(404);
    // Re-publishing mints a NEW token; the old link stays dead.
    const again = await inject('PATCH', `/workspaces/${wsId}/skills/${made.json().id}`, { visibility: 'public' });
    expect(again.json().public_token).toBeTruthy();
    expect(again.json().public_token).not.toBe(token);
    expect((await app.inject({ method: 'GET', url: `/api/v1/public/skills/${token}` })).statusCode).toBe(404);
  });

  it('version: defaults to 1.0.0, is settable, must be semver, and travels in the SKILL.md frontmatter and back through import', async () => {
    const made = await inject('POST', `/workspaces/${wsId}/skills`, base('Versioned'));
    expect(made.json().version).toBe('1.0.0');
    const id = made.json().id;
    expect((await inject('PATCH', `/workspaces/${wsId}/skills/${id}`, { version: 'v2' })).statusCode).toBe(422);
    const bumped = await inject('PATCH', `/workspaces/${wsId}/skills/${id}`, { version: '1.2.0' });
    expect(bumped.json().version).toBe('1.2.0');

    const exported = (await inject('GET', `/workspaces/${wsId}/skills/${id}/export?format=claude_skill`)).json().content as string;
    expect(exported).toMatch(/^---\nname: versioned\ndescription: .*\nversion: 1\.2\.0\n---/);
    const imported = await inject('POST', `/workspaces/${wsId}/skills/import`, { content: exported, create: true });
    expect(imported.statusCode, imported.body).toBe(201);
    expect(imported.json().created.version).toBe('1.2.0');
    expect(imported.json().report.dropped.map((d: { item: string }) => d.item)).not.toContain('frontmatter `version`');
  });

  it('a member removed from the workspace no longer sees what was shared with them, and is cleaned up with the rest of their access (GDPR)', async () => {
    const made = await inject('POST', `/workspaces/${wsId}/skills`, { ...base('Share then erase'), visibility: 'members', member_ids: [cId] }, member.token);
    const id = made.json().id;
    const members = (await inject('GET', `/workspaces/${wsId}/members`)).json();
    const cMembership = (members.data ?? members).find((m: { user_id?: string; userId?: string }) => (m.user_id ?? m.userId) === cId);
    expect(cMembership, 'C is a member').toBeTruthy();

    const exp = await inject('GET', `/workspaces/${wsId}/members/${cMembership.id}/gdpr/export`);
    expect(exp.statusCode, exp.body).toBe(200);
    expect(exp.json().skill_shares.map((s: { skill_id: string }) => s.skill_id)).toContain(id);

    const erased = await inject('POST', `/workspaces/${wsId}/members/${cMembership.id}/gdpr/anonymize`);
    expect(erased.statusCode, erased.body).toBeLessThan(300);
    expect(erased.json().removed.skill_shares).toBeGreaterThanOrEqual(1);
    // The owner's view of the audience no longer names the erased person.
    expect((await inject('GET', `/workspaces/${wsId}/skills/${id}`, undefined, member.token)).json().member_ids).not.toContain(cId);
  });
  it('ERASURE POLICY: erasing an AUTHOR keeps the workspace\'s skill, keeps owner_id as a bare id, and that id now resolves to a tombstone with no PII', async () => {
    const author = await signUpUser(app, 'SkillAuthorToErase');
    await joinAsMember(author);
    const authorId = (await inject('GET', '/me', undefined, author.token)).json().id;
    const made = await inject('POST', `/workspaces/${wsId}/skills`, base('Process that outlives its author'), author.token);
    expect(made.statusCode, made.body).toBe(201);
    const skillId = made.json().id;
    expect(made.json().owner_id).toBe(authorId);

    const members = (await inject('GET', `/workspaces/${wsId}/members`)).json();
    const membership = (members.data ?? members).find((m: { user_id?: string; userId?: string }) => (m.user_id ?? m.userId) === authorId);
    const erased = await inject('POST', `/workspaces/${wsId}/members/${membership.id}/gdpr/anonymize`);
    expect(erased.statusCode, erased.body).toBeLessThan(300);

    // A skill is the workspace's process, not the author's personal data: it is NOT deleted.
    const still = await inject('GET', `/workspaces/${wsId}/skills/${skillId}`);
    expect(still.statusCode).toBe(200);
    expect(still.json().instructions).toBe(baseSkill.instructions);
    // The author link stays a bare id...
    expect(still.json().owner_id).toBe(authorId);
    // ...and that id resolves to a tombstoned user row: nothing identifying is left to point at.
    const row = await app.get<Db>(DB).query.user.findFirst({ where: eq(userTable.id, authorId) });
    expect(row?.name).toBe('Deleted user');
    expect(row?.email).toBe(`deleted-${authorId}@anonymized.invalid`);
    expect(row?.image).toBeNull();
    // Admins can still read and own the accountability: the skill remains editable by nobody
    // but its (now unresolvable) owner, which is the "admins (author left)" state the design renders.
    expect(still.json().editable).toBe(false);
  });
});

