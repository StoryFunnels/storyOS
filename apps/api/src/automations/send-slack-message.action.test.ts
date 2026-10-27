import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { SlackService } from '../integrations/slack.service';
import type { JobRunnerService } from './job-runner.service';
import type { ApprovalsService } from './approvals.service';
import type { AutomationAction } from '@storyos/schemas';
import { AutomationActionsService, type ActionContext } from './actions.service';

/**
 * #1075 — a send_slack_message template is the automation author's own mrkdwn and stays live, but every {Field} value
 * substituted into it is record text any editor can set, so it reaches Slack escaped. Only the calls the inline Slack
 * branch makes are stubbed; validate() is the schema re-check covered elsewhere.
 */
function build() {
  const posts: Array<{ channel?: string; text: string }> = [];
  const approvals: Array<{ action: AutomationAction; previewText: string }> = [];
  const db = {
    query: {
      fields: {
        findMany: vi.fn().mockResolvedValue([
          { displayName: 'Name', apiName: 'name' },
          { displayName: 'Notes', apiName: 'notes' },
        ]),
      },
    },
  } as unknown as Db;
  const slack = {
    sendMessage: vi.fn(async (_ws: string, msg: { channel?: string; text: string }) => {
      posts.push(msg);
      return { ok: true as const, via: 'bot' as const, channel: msg.channel };
    }),
  } as unknown as SlackService;
  const approvalsService = {
    create: vi.fn(async (input: { action: AutomationAction; previewText: string }) => {
      approvals.push(input);
      return { type: 'approval', summary: 'held' };
    }),
  } as unknown as ApprovalsService;
  const service = new AutomationActionsService(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    slack,
    {} as never,
    { hasExecutor: () => false } as unknown as JobRunnerService,
    approvalsService,
  );
  vi.spyOn(service, 'validate').mockResolvedValue(undefined as never);
  return { service, posts, approvals };
}

const ctx = (): ActionContext =>
  ({
    workspaceId: 'ws1',
    databaseId: 'db1',
    actorId: 'u1',
    record: {
      id: 'r1',
      title: '<!channel> Q&A',
      number: 7,
      values: { notes: '<https://evil.example|Click here>' },
    },
  }) as unknown as ActionContext;

const action = (extra: Record<string, unknown> = {}) =>
  ({
    type: 'send_slack_message',
    channel: '#ops',
    text: '<!here> *New:* {Name} — {Notes}',
    ...extra,
  }) as unknown as AutomationAction;

describe('send_slack_message escapes substituted values (#1075)', () => {
  it("sends record values as literal text and keeps the author's own mrkdwn live", async () => {
    const { service, posts } = build();
    await service.execute([action()], ctx());
    expect(posts).toEqual([
      {
        channel: '#ops',
        text: '<!here> *New:* &lt;!channel&gt; Q&amp;A — &lt;https://evil.example|Click here&gt;',
      },
    ]);
  });

  it('the approval snapshot is rendered with the same escape, so approve() sends what the approver saw', async () => {
    const { service, posts, approvals } = build();
    await service.execute([action({ require_approval: true })], ctx());
    expect(posts).toHaveLength(0);
    expect((approvals[0]!.action as { text: string }).text).toBe(
      '<!here> *New:* &lt;!channel&gt; Q&amp;A — &lt;https://evil.example|Click here&gt;',
    );
  });
});
