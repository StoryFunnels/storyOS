import { describe, expect, it } from 'vitest';
import {
  commentBodyMentions,
  commentBodyText,
  isBlocknoteCommentBody,
  type BlocknoteCommentBody,
  type CommentSegment,
} from './comments.service';

/**
 * #180 — dual-format comment bodies. The server extracts @user + #record mentions
 * and a plain-text preview from EITHER the legacy segment array or the new
 * BlockNote shape. These are the seams create()/update()/notifyMentions() rely on,
 * so both shapes are pinned here.
 */
describe('comment body (#180) — legacy segments vs BlockNote', () => {
  const legacy: CommentSegment[] = [
    { type: 'text', text: 'hi ' },
    { type: 'mention', user_id: 'u1' },
    { type: 'text', text: ' see ' },
    { type: 'record', record_id: 'rec-1', database_id: 'db-1' },
    { type: 'mention', user_id: 'u1' }, // duplicate — must dedupe
  ];

  // Mirrors what BlockNote serializes: blocks with inline `mention` nodes shaped
  // { type:'mention', props:{ kind:'user'|'record', id } } (the shared MN-205 node).
  const blocknote: BlocknoteCommentBody = {
    format: 'blocknote',
    doc: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'hi ' },
          { type: 'mention', props: { kind: 'user', id: 'u1', label: 'Bob' } },
          { type: 'text', text: ' see ' },
          { type: 'mention', props: { kind: 'record', id: 'rec-1', label: 'Thing' } },
          { type: 'mention', props: { kind: 'user', id: 'u1' } }, // duplicate
        ],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'second line' }],
      },
    ],
  };

  it('discriminates the two shapes', () => {
    expect(isBlocknoteCommentBody(blocknote)).toBe(true);
    expect(isBlocknoteCommentBody(legacy)).toBe(false);
  });

  it('extracts the same deduped mentions from a legacy body', () => {
    expect(commentBodyMentions(legacy)).toEqual({ userIds: ['u1'], recordIds: ['rec-1'] });
  });

  it('extracts @user + #record mentions from a BlockNote doc', () => {
    expect(commentBodyMentions(blocknote)).toEqual({ userIds: ['u1'], recordIds: ['rec-1'] });
  });

  it('builds a plain-text preview from a legacy body (mentions collapse to @…)', () => {
    expect(commentBodyText(legacy)).toBe('hi @… see @…@…');
  });

  it('builds a plain-text preview from a BlockNote doc, blocks space-joined', () => {
    expect(commentBodyText(blocknote)).toBe('hi @… see @…@… second line');
  });
});
