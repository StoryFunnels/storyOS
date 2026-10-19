import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { authed, signUpUser } from './helpers/users';
import { makeLinearFetcher, manyIssues } from './helpers/linear-fake';
import { LinearService } from '../src/integrations/linear.service';

/**
 * #959 — ensureTeamPack found the team's space and databases by NAME with no deleted_at filter, so a mirror someone had
 * TRASHED was picked up again and every sync died on `unknown field "linear_id" in filter` (the trashed database's fields
 * are gone). A trashed mirror could never be re-imported. A live mirror, and what the sync does when more than one live
 * space carries the name, are pinned here too.
 */
const empty = { labels: { nodes: [] as unknown[] }, cycles: { nodes: [] as unknown[] }, projects: { nodes: [] as unknown[] } };
const TEAM = { id: 'team-t', key: 'TR', name: 'Trashy' };
const SPACE = 'Trashy (Linear)';
const issue = (n: number) => ({ ...manyIssues(1)[0]!, id: `t${n}`, identifier: `TR-${n}`, title: `Issue ${n}`, description: null });

let app: NestFastifyApplication;
let linear: LinearService;
let admin: { token: string };
let ws: string;
const inject = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as never, url: `/api/v1${url}`, headers: authed(admin.token), payload: payload as never });
const use = (n: number) => {
  linear.fetcher = makeLinearFetcher([{ ...TEAM, data: { ...empty, issues: { nodes: Array.from({ length: n }, (_, i) => issue(i + 1)) } } }]).fetcher;
};
const sync = () => inject('POST', `/workspaces/${ws}/integrations/linear/sync`);
const liveSpaces = async () => ((await inject('GET', `/workspaces/${ws}/spaces`)).json() as Array<{ id: string; name: string }>).filter((s) => s.name === SPACE);
const issuesDbOf = async (spaceId: string) =>
  ((await inject('GET', `/workspaces/${ws}/databases`)).json() as Array<{ id: string; name: string; space_id?: string; spaceId?: string }>).find(
    (d) => d.name === 'Issues' && (d.space_id ?? d.spaceId) === spaceId,
  );
const recordCount = async (dbId: string) => ((await inject('GET', `/workspaces/${ws}/databases/${dbId}/records?limit=200`)).json().data as unknown[]).length;

beforeAll(async () => {
  app = await createTestApp();
  linear = app.get(LinearService);
  admin = await signUpUser(app, 'Linear Trash');
  ws = (await inject('POST', '/workspaces', { name: 'Linear Trash WS' })).json().id;
  expect((await inject('POST', `/workspaces/${ws}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['TR'] })).statusCode).toBe(201);
}, 120_000);
afterAll(async () => { await app.close(); });

describe('#959 a trashed mirror is not resurrected', () => {
  it('trash the team space, sync: a NEW space with fresh databases is imported into, with no error', async () => {
    use(2);
    expect((await sync()).statusCode).toBe(201);
    const [first] = await liveSpaces();
    expect(first, 'the first import made the space').toBeTruthy();
    const firstIssues = (await issuesDbOf(first!.id))!;
    expect(await recordCount(firstIssues.id)).toBe(2);

    const del = await inject('DELETE', `/workspaces/${ws}/spaces/${first!.id}`, { confirm: SPACE });
    expect(del.statusCode, del.body).toBe(200);
    expect(await liveSpaces(), 'precondition: nothing live under that name').toHaveLength(0);

    const res = await sync();
    expect(res.statusCode, `a trashed mirror must not break the sync: ${res.body}`).toBe(201);
    const live = await liveSpaces();
    expect(live).toHaveLength(1);
    expect(live[0]!.id, 'a NEW space, not the trashed one').not.toBe(first!.id);
    const freshIssues = (await issuesDbOf(live[0]!.id))!;
    expect(freshIssues.id).not.toBe(firstIssues.id);
    expect(await recordCount(freshIssues.id), 'the issues were imported into the new mirror').toBe(2);

    // an UNtrashed mirror is untouched by a further sync: idempotent by linear_id
    use(3);
    expect((await sync()).statusCode).toBe(201);
    expect(await liveSpaces()).toHaveLength(1);
    expect(await recordCount(freshIssues.id), '2 existing + 1 new, no duplicates').toBe(3);
    (globalThis as Record<string, unknown>).__trashedSpace = first!.id;
  });

  it('restoring the old space over a live mirror is allowed and NOT silent: the sync imports into the NEWEST live space and says so', async () => {
    const oldId = (globalThis as Record<string, unknown>).__trashedSpace as string;
    const newest = (await liveSpaces())[0]!;
    const oldIssues = (await issuesDbOf(oldId)) ?? undefined;
    expect((await inject('POST', `/workspaces/${ws}/spaces/${oldId}/restore`)).statusCode).toBe(201);
    expect(await liveSpaces()).toHaveLength(2);
    const before = oldIssues ? await recordCount(oldIssues.id) : 0;

    use(4);
    const res = await sync();
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().warnings?.join(' ') ?? '', 'the sync says two live spaces share the name').toContain('2 live spaces');
    expect(await recordCount((await issuesDbOf(newest.id))!.id), 'the newest got the new issue').toBe(4);
    if (oldIssues) expect(await recordCount(oldIssues.id), 'the restored copy was left alone').toBe(before);
  });
});

describe('#959 a half-present mirror is refused by name, not duplicated', () => {
  it('a live space whose Issues database is trashed: the error names the team and the reason, and nothing is created', async () => {
    const [keep] = (await liveSpaces()).slice(0, 1);
    // leave exactly one live space: trash the other
    const all = await liveSpaces();
    for (const s of all.slice(1)) expect((await inject('DELETE', `/workspaces/${ws}/spaces/${s.id}`, { confirm: SPACE })).statusCode).toBe(200);
    const issuesDb = (await issuesDbOf(keep!.id))!;
    const delDb = await inject('DELETE', `/workspaces/${ws}/databases/${issuesDb.id}`, { confirm: 'Issues', sever_relations: true });
    expect(delDb.statusCode, delDb.body).toBe(200);
    const dbsBefore = ((await inject('GET', `/workspaces/${ws}/databases`)).json() as unknown[]).length;
    use(4);
    const res = await sync();
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('team TR');
    expect(res.body).toContain('Issues');
    expect(res.body).not.toContain('unknown field');
    expect(((await inject('GET', `/workspaces/${ws}/databases`)).json() as unknown[]).length, 'no duplicate databases were created').toBe(dbsBefore);
  });
});

describe('#959 a sync error names the team', () => {
  const failWith = async (error: Error) => {
    const ws2 = (await inject('POST', '/workspaces', { name: `Linear Trash ${Math.random().toString(36).slice(2)}` })).json().id as string;
    expect((await inject('POST', `/workspaces/${ws2}/integrations/linear`, { api_key: 'lin_api_test', team_keys: ['TR'] })).statusCode).toBe(201);
    use(1);
    const spy = vi.spyOn((linear as unknown as { externalIdUpsert: { upsert: () => Promise<unknown> } }).externalIdUpsert, 'upsert').mockRejectedValue(error);
    try {
      const res = await inject('POST', `/workspaces/${ws2}/integrations/linear/sync`);
      const status = (await inject('GET', `/workspaces/${ws2}/integrations/linear`)).json().sync.last_error as string;
      return { res, status };
    } finally {
      spy.mockRestore();
    }
  };

  it('a validation-style failure inside a team\'s import reads "team TR: ..." to the caller AND on the integration page, with its 422 kept', async () => {
    const { res, status } = await failWith(new UnprocessableEntityException('unknown field "linear_id" in filter'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toBe('team TR: unknown field "linear_id" in filter');
    expect(status).toContain('team TR: unknown field "linear_id" in filter');
  });

  it('an unexpected failure is still a masked 500 to the caller, but the integration page names the team', async () => {
    const { res, status } = await failWith(new Error('boom'));
    expect(res.statusCode).toBe(500);
    expect(status).toContain('team TR: boom');
  });
});
