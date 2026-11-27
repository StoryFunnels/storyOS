import { describe, expect, it } from 'vitest';
import { registerTools } from './tools.js';
import type { Ctx } from './client.js';

/** Ticket #1370 - an agent may READ who owns each Linear team's records; flipping the switch is human-only (coverage.ts). */
describe('get_linear_ownership: who owns each Linear team', () => {
  const TEAMS = [{ team_key: 'ENG', owner: 'storyos', cut_over_at: '2026-12-01T00:00:00.000Z' }, { team_key: 'QUA', owner: 'linear' }];
  function harness(scope: 'read' | 'admin') {
    const handlers = new Map<string, (a: unknown) => Promise<unknown>>();
    const server = { registerTool: (n: string, _c: unknown, h: (a: unknown) => Promise<unknown>) => handlers.set(n, h) };
    const client = {
      GET: async (path: string) => {
        if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'JCM Agency' }] };
        if (path === '/api/v1/workspaces/{ws}/linear/ownership') return { data: { data: TEAMS } };
        throw new Error(`unmocked GET ${path}`);
      },
    } as never;
    registerTools(server as never, { client, baseUrl: 'x', token: 't' } as Ctx, { scope, allowRunButton: true });
    return handlers;
  }

  it('reads the per-team owner at read scope', async () => {
    const res = (await harness('read').get('get_linear_ownership')!({ workspace: 'JCM Agency' })) as { content: Array<{ text: string }> };
    expect(JSON.parse(res.content[0]!.text)).toEqual(TEAMS);
  });

  it('there is no tool that flips it: the switch is human-only', () => {
    const names = [...harness('admin').keys()].filter((n) => /linear/i.test(n));
    expect(names).toEqual(['get_linear_ownership']);
  });
});
