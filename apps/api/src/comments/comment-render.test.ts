import { describe, expect, it } from 'vitest';
import {
  commentDeepLink,
  commentMentionIds,
  isBlocknoteCommentBody,
  renderCommentText,
  truncateForPreview,
} from './comment-render';
import type { BlocknoteCommentBody, CommentSegment } from './comments.service';

/**
 * #235 — one shared renderer feeds every channel (mention email, in-app inbox,
 * future Slack), so the same comment event reads identically everywhere. These
 * pin name resolution, dual-format parity, truncation, and the deep link.
 */
describe('renderCommentText (#235)', () => {
  const names = new Map([
    ['u1', 'Bob'],
    ['u2', 'Cara'],
  ]);
  const titles = new Map([['rec-1', 'Roadmap']]);

  const legacy: CommentSegment[] = [
    { type: 'text', text: 'hi ' },
    { type: 'mention', user_id: 'u1' },
    { type: 'text', text: ', see ' },
    { type: 'record', record_id: 'rec-1', database_id: 'db-1' },
  ];

  const blocknote: BlocknoteCommentBody = {
    format: 'blocknote',
    doc: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'hi ' },
          { type: 'mention', props: { kind: 'user', id: 'u1' } },
          { type: 'text', text: ', see ' },
          { type: 'mention', props: { kind: 'record', id: 'rec-1' } },
        ],
      },
    ],
  };

  it('resolves @user and #record mentions to readable names when a context is given', () => {
    expect(renderCommentText(legacy, { userNames: names, recordTitles: titles })).toBe('hi @Bob, see #Roadmap');
  });

  it('falls back to @someone / #record when a mention is unresolved', () => {
    expect(renderCommentText(legacy)).toBe('hi @someone, see #record');
  });

  it('renders legacy and BlockNote shapes to the SAME text (channel parity)', () => {
    const ctx = { userNames: names, recordTitles: titles };
    expect(renderCommentText(blocknote, ctx)).toBe(renderCommentText(legacy, ctx));
  });

  it('still discriminates the two body shapes', () => {
    expect(isBlocknoteCommentBody(blocknote)).toBe(true);
    expect(isBlocknoteCommentBody(legacy)).toBe(false);
  });

  it('collects deduped mention ids from either shape', () => {
    expect(commentMentionIds(legacy)).toEqual({ userIds: ['u1'], recordIds: ['rec-1'] });
    expect(commentMentionIds(blocknote)).toEqual({ userIds: ['u1'], recordIds: ['rec-1'] });
  });
});

describe('truncateForPreview (#235)', () => {
  it('returns short text untouched', () => {
    expect(truncateForPreview('hello there', 200)).toBe('hello there');
  });

  it('breaks on a word boundary and appends an ellipsis', () => {
    const out = truncateForPreview('the quick brown fox jumps over', 12);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('brow…'); // never a half-word when a boundary is near
    expect(out).toBe('the quick…');
  });

  it('hard-cuts when there is no nearby space (one long token)', () => {
    expect(truncateForPreview('a'.repeat(20), 10)).toBe(`${'a'.repeat(10)}…`);
  });

  it('inbox (120) and email (200) previews of the same render agree on their shared prefix', () => {
    const rendered = `Bob wrote a fairly long comment ${'word '.repeat(60)}end`;
    const inbox = truncateForPreview(rendered, 120);
    const email = truncateForPreview(rendered, 200);
    const prefix = inbox.replace(/…$/, '');
    expect(email.startsWith(prefix)).toBe(true);
  });
});

describe('commentDeepLink (#235)', () => {
  it('targets the exact comment on the record', () => {
    expect(commentDeepLink('https://app.example.com', 'r1', 'c9')).toBe(
      'https://app.example.com/r/r1?comment=c9',
    );
  });
});
