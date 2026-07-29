import { describe, expect, it } from 'vitest';
import {
  filterMembers,
  mentionInsertContent,
  recordMentionProps,
  recordRowLabel,
  userMentionProps,
  type SearchRecord,
} from './mention-items';

const rec: SearchRecord = {
  id: 'rec_1',
  title: 'Phoenix launch checklist',
  database_id: 'db_1',
  database_name: 'Open Tasks',
  number: 12,
};

describe('# record picker mapping (#139)', () => {
  it('maps a search hit to a #<number> + name row across databases', () => {
    expect(recordRowLabel(rec)).toEqual({
      number: 12,
      title: 'Phoenix launch checklist',
      database: 'Open Tasks',
    });
  });

  it('degrades a missing number to null (renders a bare #) and an empty title to Untitled', () => {
    const row = recordRowLabel({ ...rec, number: null, title: '' });
    expect(row.number).toBeNull();
    expect(row.title).toBe('Untitled');
  });

  it('builds a record mention that carries the id + db so the chip links and resolves', () => {
    expect(recordMentionProps(rec)).toEqual({
      kind: 'record',
      id: 'rec_1',
      label: 'Phoenix launch checklist',
      db: 'db_1',
    });
  });
});

describe('@ member picker mapping (#139)', () => {
  const members = [
    { id: 'u1', name: 'Ada Lovelace', image: 'https://x/a.png' },
    { id: 'u2', name: 'Alan Turing', image: null },
    { id: 'u3', name: 'Grace Hopper' },
  ];

  it('filters members case-insensitively by name substring', () => {
    // Case-insensitive: upper-case query matches the lower-cased name.
    expect(filterMembers(members, 'LACE').map((m) => m.id)).toEqual(['u1']);
    // Substring anywhere in the name (first or last word).
    expect(filterMembers(members, 'turing').map((m) => m.id)).toEqual(['u2']);
    // Empty query returns everyone.
    expect(filterMembers(members, '').map((m) => m.id)).toEqual(['u1', 'u2', 'u3']);
  });

  it('builds a user mention (no db) preserving the id + name snapshot', () => {
    expect(userMentionProps(members[0]!)).toEqual({
      kind: 'user',
      id: 'u1',
      label: 'Ada Lovelace',
      db: '',
    });
  });
});

describe('mention serialize / round-trip', () => {
  it('inserts a mention node + trailing space and survives a save/reload as structured content', () => {
    const props = recordMentionProps(rec);
    const content = mentionInsertContent(props);

    // The mention is a structured inline node, not a flattened string.
    expect(content[0]).toEqual({ type: 'mention', props });
    expect(content[1]).toBe(' ');

    // Save (serialize) then reload (parse) — every durable prop must survive.
    const reloaded = JSON.parse(JSON.stringify(content)) as typeof content;
    expect(reloaded[0].type).toBe('mention');
    expect(reloaded[0].props).toEqual({
      kind: 'record',
      id: 'rec_1',
      label: 'Phoenix launch checklist',
      db: 'db_1',
    });
  });
});
