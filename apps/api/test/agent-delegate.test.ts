import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';

let app: NestFastifyApplication;
let admin: { token: string; email: string };
let member: { token: string; email: string };
let wsId: string;
let agentsDbId: string;
let runsDbId: string;
let ticketsDbId: string;

async function as(token: string, method: string, url: string, payload?: unknown) {
  return app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(token), payload: payload as never });
}

async function createAgent(name: string, opts: { enabled: boolean }) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${agentsDbId}/records`, {
    values: { name, enabled: opts.enabled },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

async function createTicket(name: string) {
  const res = await as(admin.token, 'POST', `/workspaces/${wsId}/databases/${ticketsDbId}/records`, {
    values: { name },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

interface CommentSegment {
  type: string;
  text?: string;
  record_id?: string;
  database_id?: string;
}
interface Comment {
  body: CommentSegment[];
}

async function commentsOn(recordId: string): Promise<Comment[]> {
  const res = await as(admin.token, 'GET', `/workspaces/${wsId}/databases/${ticketsDbId}/records/${recordId}/comments`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data;
}

beforeAll(async () => {
  app = await createTestApp();
  admin = await signUpUser(app, 'DelegateAdmin');
  member = await signUpUser(app, 'DelegateMember');

  wsId = (await as(admin.token, 'POST', '/workspaces', { name: 'Delegate WS' })).json().id;

  const invite = await as(admin.token, 'POST', `/workspaces/${wsId}/invites`, {
    email: member.email,
    role: 'member',
  });
  const token = new URL(invite.json().accept_url).searchParams.get('token')!;
  await as(member.token, 'POST', '/invites/accept', { token });

  const ensured = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/ensure`);
  expect(ensured.statusCode, ensured.body).toBe(201);
  agentsDbId = ensured.json().agentsDb.id;
  runsDbId = ensured.json().runsDb.id;

  const spaceId = (await as(admin.token, 'GET', `/workspaces/${wsId}/spaces`)).json()[0].id;
  const tickets = await as(admin.token, 'POST', `/workspaces/${wsId}/databases`, {
    name: 'Tickets',
    space_id: spaceId,
  });
  expect(tickets.statusCode, tickets.body).toBe(201);
  ticketsDbId = tickets.json().id;
});

afterAll(async () => {
  await app.close();
});

describe('Delegate to agent (#44 — the integrations-directory flagship card)', () => {
  it('runs the agent with the record as context and posts the outcome back as a comment', async () => {
    const agent = await createAgent('Triage bot', { enabled: true });
    const ticket = await createTicket('Fix the thing');

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/delegate`, {
      record_id: ticket.id,
    });
    expect(res.statusCode, res.body).toBe(201);
    const run = res.json();
    expect(run.title).toBe('Triage bot — Manual');
    expect(run.values.input_record).toBe(ticket.id);

    const comments = await commentsOn(ticket.id);
    expect(comments.length).toBe(1);
    const body = comments[0]!.body;
    const text = body.find((s) => s.type === 'text');
    expect(text?.text).toContain('Triage bot');
    expect(text?.text).toContain('Succeeded');
    const recordSegment = body.find((s) => s.type === 'record');
    expect(recordSegment?.record_id).toBe(run.id);
    expect(recordSegment?.database_id).toBe(runsDbId);
  });

  it('a disabled agent is 422 and posts no comment', async () => {
    const agent = await createAgent('Sleeping bot', { enabled: false });
    const ticket = await createTicket('Untouched');

    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/delegate`, {
      record_id: ticket.id,
    });
    expect(res.statusCode, res.body).toBe(422);
    expect(await commentsOn(ticket.id)).toEqual([]);
  });

  it('404s for a record that does not exist in this workspace', async () => {
    const agent = await createAgent('Another bot', { enabled: true });
    const res = await as(admin.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/delegate`, {
      record_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });

  it('is admin-only — a non-admin member gets 403', async () => {
    const agent = await createAgent('Guarded bot', { enabled: true });
    const ticket = await createTicket('Members cannot delegate');
    const res = await as(member.token, 'POST', `/workspaces/${wsId}/agents/${agent.id}/delegate`, {
      record_id: ticket.id,
    });
    expect(res.statusCode).toBe(403);
  });
});
