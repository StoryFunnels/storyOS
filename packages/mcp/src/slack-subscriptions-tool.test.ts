import { describe, expect, it } from 'vitest';
import { registerTools } from './tools.js';
import type { Ctx } from './client.js';
import { EXCLUDED } from './coverage.js';

/**
 * Ticket #1377 - Slack channel subscriptions over MCP: an agent may LIST them (to see what posts where, and whether one stopped because
 * its creator lost access), and may NOT create, change or delete one. Choosing where a workspace's records are sent is a person's call.
 */
const LIST = '/api/v1/workspaces/{ws}/integrations/slack/subscriptions';

function harness() {
  const gets: Array<{ path: string; params: unknown }> = [];
  const names: string[] = [];
  const handlers = new Map<string, (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  const client = {
    GET: async (path: string, opts?: { params?: unknown }) => {
      gets.push({ path, params: opts?.params });
      if (path === '/api/v1/workspaces') return { data: [{ id: 'ws-1', name: 'Eng' }] };
      if (path === LIST) return { data: { data: [{ id: 's1', channel: 'eng', events: ['created'], needs_attention: 'creator_left', failed_count: 2 }] } };
      throw new Error(`unexpected GET ${path}`);
    },
  };
  registerTools(
    { registerTool: (n: string, _c: never, h: never) => { names.push(n); handlers.set(n, h as never); } } as never,
    { client: client as never, baseUrl: 'http://t', token: 't' } as Ctx,
    { scope: 'admin', allowRunButton: true },
  );
  return { gets, names, handlers };
}

describe('ticket #1377 - list_slack_subscriptions', () => {
  it('reads the workspace\'s subscriptions and returns the server\'s answer untouched, needs_attention and counts included', async () => {
    const { handlers, gets } = harness();
    const res = await handlers.get('list_slack_subscriptions')!({ workspace: 'Eng' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0]!.text)).toMatchObject({ data: [{ channel: 'eng', needs_attention: 'creator_left', failed_count: 2 }] });
    expect(gets.find((g) => g.path === LIST)!.params).toEqual({ path: { ws: 'ws-1' } });
  });

  it('there is NO tool that creates, changes or removes a subscription (the human-only guard: a new tool of that shape fails here)', () => {
    const { names } = harness();
    const slackish = names.filter((n) => /slack/i.test(n));
    expect(slackish).toEqual(['list_slack_subscriptions']);
    expect(names.filter((n) => /subscri/i.test(n) && !/^list_/.test(n) && !/webhook/i.test(n))).toEqual([]);
  });

  it('the writes are recorded as EXCLUDED with their reason, and the list is not (a tool reaches it)', () => {
    const rule = EXCLUDED.find((r) => r.match instanceof RegExp && r.match.test('POST /api/v1/workspaces/{ws}/integrations/slack/subscriptions'));
    expect(rule?.reason).toContain('#1377');
    for (const op of ['POST', 'PATCH', 'DELETE']) {
      const path = op === 'POST' ? LIST : `${LIST}/{id}`;
      expect(EXCLUDED.some((r) => r.match instanceof RegExp && r.match.test(`${op} ${path}`)), `${op} ${path}`).toBe(true);
    }
    const blanket = EXCLUDED.find((r) => r.match instanceof RegExp && r.match.test('POST /api/v1/workspaces/{ws}/integrations/slack'));
    expect(blanket, 'the Slack credential config stays excluded as before').toBeTruthy();
    expect(blanket!.match instanceof RegExp && blanket!.match.test(`GET ${LIST}`), 'the list must not be swallowed by the blanket integrations rule').toBe(false);
  });
});
