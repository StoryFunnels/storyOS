import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/client';
import type { EmailService } from '../mail/email.service';
import type { NotificationsService } from '../notifications/notifications.service';
import type { MentionsService } from '../mentions/mentions.service';
import type { PreferencesService } from '../users/preferences.service';
import { DEFAULT_PREFERENCES } from '../users/preferences.constants';
import { CommentsService } from './comments.service';
import { renderCommentText } from './comment-render';

/** Builds a CommentsService whose private notifyMentions() can be exercised
 * directly (it's the MN-103 send point) without the surrounding create()
 * transaction/db churn. Only the calls notifyMentions makes are stubbed. */
function buildService(opts: {
  mentionedUsers: Array<{ id: string; email: string; name: string }>;
  mentionedToggleByUser?: Record<string, boolean>;
  recordTitle?: string;
  authorName?: string;
}) {
  const sent: Array<{ kind: string; to: string; excerpt?: string; url?: string }> = [];
  const emailService = {
    send: vi.fn(async (input: { kind: string; to: string; excerpt?: string; url?: string }) => {
      sent.push({ kind: input.kind, to: input.to, excerpt: input.excerpt, url: input.url });
    }),
  } as unknown as EmailService;

  const preferences = {
    notificationPrefsFor: vi.fn(async (ids: string[]) => {
      const map = new Map<string, typeof DEFAULT_PREFERENCES.notifications>();
      for (const id of ids) {
        map.set(id, {
          ...DEFAULT_PREFERENCES.notifications,
          mentioned: opts.mentionedToggleByUser?.[id] ?? true,
        });
      }
      return map;
    }),
  } as unknown as PreferencesService;

  const db = {
    query: {
      records: {
        findFirst: vi.fn().mockResolvedValue({ id: 'r1', title: opts.recordTitle ?? 'a record', databaseId: 'db1' }),
      },
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: 'author1', name: opts.authorName ?? 'Ada' }),
        findMany: vi.fn().mockResolvedValue(opts.mentionedUsers),
      },
    },
  } as unknown as Db;

  const service = new CommentsService(
    db,
    {} as unknown as NotificationsService,
    {} as unknown as MentionsService,
    emailService,
    preferences,
  );
  return { service, sent, preferences };
}

/** notifyMentions is private — this is the send point MN-103 wires up, and the
 * repo's existing test style already casts around private methods where
 * exercising the full public flow would mean re-implementing an unrelated
 * transaction (see comments.service.ts's own db.transaction in create()). */
function callNotifyMentions(
  service: CommentsService,
  recordId: string,
  authorId: string,
  mentioned: Array<{ id: string; name: string | null; email: string }>,
  rendered = 'hi there',
  commentId = 'c1',
  workspaceId = 'ws1', // MN-194 — notifyMentions takes workspaceId (cost attribution)
): Promise<void> {
  // #235 — notifyMentions now receives the already-loaded mentioned users and the
  // comment pre-rendered once by create(), so email matches the inbox snippet.
  return (
    service as unknown as {
      notifyMentions: (
        w: string,
        r: string,
        a: string,
        c: string,
        m: Array<{ id: string; name: string | null; email: string }>,
        rendered: string,
      ) => Promise<void>;
    }
  ).notifyMentions(workspaceId, recordId, authorId, commentId, mentioned, rendered);
}

describe('CommentsService — mention email send point (MN-103)', () => {
  it('emails a mentioned user who has not opted out, with the comment text and an exact-comment deep link', async () => {
    const { service, sent } = buildService({
      mentionedUsers: [{ id: 'u1', email: 'u1@example.com', name: 'Bob' }],
    });

    await callNotifyMentions(
      service,
      'r1',
      'author1',
      [{ id: 'u1', email: 'u1@example.com', name: 'Bob' }],
      'hey @Bob take a look',
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'mention', to: 'u1@example.com', excerpt: 'hey @Bob take a look' });
    // #235 — the link targets the exact comment, shared across every channel.
    expect(sent[0]!.url).toContain('/r/r1?comment=c1');
  });

  it('honors the existing "Mentions" notification toggle as the v1 email opt-out (#31/MN-103)', async () => {
    const { service, sent, preferences } = buildService({
      mentionedUsers: [{ id: 'u1', email: 'u1@example.com', name: 'Bob' }],
      mentionedToggleByUser: { u1: false },
    });

    await callNotifyMentions(service, 'r1', 'author1', [{ id: 'u1', email: 'u1@example.com', name: 'Bob' }]);

    expect(preferences.notificationPrefsFor).toHaveBeenCalledWith(['u1']);
    expect(sent).toEqual([]);
  });

  it('never emails the comment author, even mentioning themselves', async () => {
    const { service, sent } = buildService({
      mentionedUsers: [{ id: 'author1', email: 'author@example.com', name: 'Ada' }],
    });

    await callNotifyMentions(service, 'r1', 'author1', [
      { id: 'author1', email: 'author@example.com', name: 'Ada' },
    ]);

    expect(sent).toEqual([]);
  });

  it('emails every opted-in mentioned user when several are tagged in one comment', async () => {
    const { service, sent } = buildService({
      mentionedUsers: [
        { id: 'u1', email: 'u1@example.com', name: 'Bob' },
        { id: 'u2', email: 'u2@example.com', name: 'Cara' },
      ],
      mentionedToggleByUser: { u2: false },
    });

    await callNotifyMentions(service, 'r1', 'author1', [
      { id: 'u1', email: 'u1@example.com', name: 'Bob' },
      { id: 'u2', email: 'u2@example.com', name: 'Cara' },
    ]);

    expect(sent.map((s) => ({ kind: s.kind, to: s.to }))).toEqual([{ kind: 'mention', to: 'u1@example.com' }]);
  });

  it('emails a BlockNote body (#180) with the mention resolved to a readable @Name (#235)', async () => {
    const { service, sent } = buildService({
      mentionedUsers: [{ id: 'u1', email: 'u1@example.com', name: 'Bob' }],
    });

    // create() renders the body once with resolved names; notifyMentions gets that string.
    const rendered = renderCommentText(
      {
        format: 'blocknote',
        doc: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'hey ' },
              { type: 'mention', props: { kind: 'user', id: 'u1' } },
            ],
          },
        ],
      },
      { userNames: new Map([['u1', 'Bob']]) },
    );

    await callNotifyMentions(service, 'r1', 'author1', [{ id: 'u1', email: 'u1@example.com', name: 'Bob' }], rendered);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'mention', to: 'u1@example.com', excerpt: 'hey @Bob' });
  });
});
