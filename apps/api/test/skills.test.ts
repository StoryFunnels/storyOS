import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

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

const baseSkill = {
  name: 'Lead triage reply drafter',
  description: 'Drafts a first-touch reply for a new lead.',
  when_to_use: 'When a new lead record needs a fast draft reply.',
  instructions: 'Read the lead, draft a short friendly reply, never invent pricing.',
  examples: [{ input: 'Lead asks about pricing', output: 'Happy to walk you through pricing!' }],
  allowed_tools: ['records.read'],
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

  it('refuses to create a SHARED skill over a token, naming why', async () => {
    const res = await inject(
      'POST',
      `/workspaces/${wsId}/skills`,
      { ...baseSkill, name: 'Agent tries to publish', visibility: 'shared' },
      pat,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().message ?? res.body).toMatch(/personal/i);
  });

  it('refuses to PROMOTE an existing skill to shared over a token', async () => {
    // Without this the create-side rule is one PATCH away from decorative.
    const created = await inject('POST', `/workspaces/${wsId}/skills`, { ...baseSkill, name: 'Promote me' }, pat);
    expect(created.statusCode).toBe(201);
    const id = created.json().id;

    const promote = await inject('PATCH', `/workspaces/${wsId}/skills/${id}`, { visibility: 'shared' }, pat);
    expect(promote.statusCode).toBe(403);

    const after = await inject('GET', `/workspaces/${wsId}/skills/${id}`, undefined, pat);
    expect(after.json().visibility).toBe('personal');
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
