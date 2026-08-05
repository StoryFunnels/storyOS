import { describe, expect, it } from 'vitest';
import {
  detectMentionTrigger,
  filterMembers,
  mentionInsertContent,
  recordBreadcrumb,
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
      color: null,
      space: null,
    });
  });

  it('degrades a missing number to null (renders a bare #) and an empty title to Untitled', () => {
    const row = recordRowLabel({ ...rec, number: null, title: '' });
    expect(row.number).toBeNull();
    expect(row.title).toBe('Untitled');
  });

  it('#178: carries the db colour + owning space and builds a `space › database` breadcrumb', () => {
    const row = recordRowLabel({ ...rec, database_color: 'blue', space_name: 'Product' });
    expect(row.color).toBe('blue');
    expect(row.space).toBe('Product');
    expect(recordBreadcrumb(row.space, row.database)).toBe('Product › Open Tasks');
  });

  it('#178: breadcrumb degrades to the database alone when the space is unknown', () => {
    expect(recordBreadcrumb(null, 'Open Tasks')).toBe('Open Tasks');
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

describe('inline @/# trigger detection in the comment composer (#171)', () => {
  it('opens the @ picker with the query typed after the trigger', () => {
    expect(detectMentionTrigger('hi @ad', 6)).toEqual({ kind: '@', query: 'ad', start: 3 });
  });

  it('opens the # picker at string start with an empty query', () => {
    expect(detectMentionTrigger('#', 1)).toEqual({ kind: '#', query: '', start: 0 });
  });

  it('closes once whitespace follows the trigger (mention is complete)', () => {
    expect(detectMentionTrigger('@Ada ', 5)).toBeNull();
    expect(detectMentionTrigger('@Ada done', 9)).toBeNull();
  });

  it('ignores a trigger not on a token boundary (e.g. an email)', () => {
    expect(detectMentionTrigger('a@b', 3)).toBeNull();
  });

  it('tracks the trigger nearest the caret, not an earlier one', () => {
    // Caret sits inside the second token → that trigger wins.
    expect(detectMentionTrigger('@one #tw', 8)).toEqual({ kind: '#', query: 'tw', start: 5 });
  });

  it('uses the caret, not the string end, so mid-string edits resolve', () => {
    // Caret after "@a" even though more text follows.
    expect(detectMentionTrigger('@ada later', 2)).toEqual({ kind: '@', query: 'a', start: 0 });
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
