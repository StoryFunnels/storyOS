import { describe, expect, it } from 'vitest';
import {
  autoMatchMapping,
  matchExistingField,
  normalizeFieldName,
  typesCompatible,
  type CatalogItem,
  type ExistingFieldLike,
} from './source-field-match';

describe('normalizeFieldName (#342 name matching)', () => {
  it('collapses case, spacing and punctuation to one comparable key', () => {
    expect(normalizeFieldName('Comment ID')).toBe('commentid');
    expect(normalizeFieldName('comment_id')).toBe('commentid');
    expect(normalizeFieldName('commentId')).toBe('commentid');
    expect(normalizeFieldName('  Published  At! ')).toBe('publishedat');
  });

  it('reduces to empty string when there is nothing alphanumeric', () => {
    expect(normalizeFieldName('   ')).toBe('');
    expect(normalizeFieldName('—')).toBe('');
  });
});

describe('typesCompatible (#342 conservative type compatibility)', () => {
  it('matches identical types', () => {
    expect(typesCompatible('text', 'text')).toBe(true);
    expect(typesCompatible('number', 'number')).toBe(true);
    expect(typesCompatible('checkbox', 'checkbox')).toBe(true);
    expect(typesCompatible('select', 'select')).toBe(true);
  });

  it('text-like keys map into plain-text fields but not validating/constrained ones', () => {
    expect(typesCompatible('text', 'rich_text')).toBe(true);
    expect(typesCompatible('text', 'title')).toBe(true); // #125 — Name is a text column
    expect(typesCompatible('text', 'url')).toBe(false);
    expect(typesCompatible('text', 'email')).toBe(false);
    expect(typesCompatible('text', 'select')).toBe(false);
    expect(typesCompatible('text', 'number')).toBe(false);
  });

  it('url keys map into a url field or any plain-text field', () => {
    expect(typesCompatible('url', 'url')).toBe(true);
    expect(typesCompatible('url', 'text')).toBe(true);
    expect(typesCompatible('url', 'rich_text')).toBe(true);
    expect(typesCompatible('url', 'number')).toBe(false);
  });

  it('number and checkbox never cross into other types', () => {
    expect(typesCompatible('number', 'text')).toBe(false);
    expect(typesCompatible('checkbox', 'text')).toBe(false);
    expect(typesCompatible('number', 'checkbox')).toBe(false);
  });
});

const field = (id: string, displayName: string, type: string, apiName?: string): ExistingFieldLike => ({
  id,
  displayName,
  apiName: apiName ?? displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
  type,
});

describe('matchExistingField (#342)', () => {
  const item: CatalogItem = { key: 'author_name', label: 'Author', suggestedType: 'text' };

  it('matches on normalized display name with a compatible type', () => {
    const fields = [field('f1', 'Author', 'text')];
    expect(matchExistingField(item, fields)?.id).toBe('f1');
  });

  it('matches on the provider key against a field apiName', () => {
    const fields = [field('f1', 'Comment author', 'text', 'author_name')];
    expect(matchExistingField(item, fields)?.id).toBe('f1');
  });

  it('does not match when the type is incompatible', () => {
    const fields = [field('f1', 'Author', 'number')];
    expect(matchExistingField(item, fields)).toBeNull();
  });

  it('does not match when the name is unrelated', () => {
    const fields = [field('f1', 'Title', 'text')];
    expect(matchExistingField(item, fields)).toBeNull();
  });

  it('returns the first field in order when several match', () => {
    const fields = [field('f1', 'Author', 'text'), field('f2', 'author', 'rich_text')];
    expect(matchExistingField(item, fields)?.id).toBe('f1');
  });

  it('#125 defaults a title-like key onto the record Name (a title field)', () => {
    const nameField = field('f-name', 'Name', 'title', 'name');
    const titleItem: CatalogItem = { key: 'title', label: 'Title', suggestedType: 'text' };
    const publishedItem: CatalogItem = { key: 'published_at', label: 'Published at', suggestedType: 'text' };
    // A title-like key maps onto Name even though "Title" never name-matches "Name".
    expect(matchExistingField(titleItem, [nameField])?.id).toBe('f-name');
    // A "name" key also lands on Name.
    expect(matchExistingField({ key: 'name', label: 'Name', suggestedType: 'text' }, [nameField])?.id).toBe('f-name');
    // But an ordinary text key never grabs Name — the record would take a wrong title.
    expect(matchExistingField(publishedItem, [nameField])).toBeNull();
  });
});

describe('autoMatchMapping (#342 existing-first, new fallback)', () => {
  const catalog: CatalogItem[] = [
    { key: 'comment_id', label: 'Comment ID', suggestedType: 'text', isKey: true },
    { key: 'like_count', label: 'Likes', suggestedType: 'number' },
    { key: 'is_reply', label: 'Is reply', suggestedType: 'checkbox' },
    { key: 'text', label: 'Text', suggestedType: 'text' },
  ];

  it('pre-selects existing fields where names+types line up, else falls back to new with the type hint', () => {
    const fields = [
      field('f-cid', 'Comment ID', 'text'),
      field('f-likes', 'Likes', 'number'),
      // no "Is reply" field, no "Text" field → those two fall back to new
    ];
    const result = autoMatchMapping(catalog, fields);
    expect(result.get('comment_id')).toEqual({ kind: 'existing', field_id: 'f-cid' });
    expect(result.get('like_count')).toEqual({ kind: 'existing', field_id: 'f-likes' });
    expect(result.get('is_reply')).toEqual({ kind: 'new', type: 'checkbox' });
    expect(result.get('text')).toEqual({ kind: 'new', type: 'text' });
  });

  it('defaults every row to new when the database has no fields', () => {
    const result = autoMatchMapping(catalog, []);
    for (const item of catalog) {
      expect(result.get(item.key)).toEqual({ kind: 'new', type: item.suggestedType });
    }
  });

  it('claims each existing field for at most one provider key', () => {
    const twoTextKeys: CatalogItem[] = [
      { key: 'text', label: 'Notes', suggestedType: 'text' },
      { key: 'notes', label: 'Notes', suggestedType: 'text' },
    ];
    const fields = [field('f-notes', 'Notes', 'text')];
    const result = autoMatchMapping(twoTextKeys, fields);
    const existingCount = [...result.values()].filter((d) => d.kind === 'existing').length;
    expect(existingCount).toBe(1);
    expect(result.get('text')).toEqual({ kind: 'existing', field_id: 'f-notes' });
    expect(result.get('notes')).toEqual({ kind: 'new', type: 'text' });
  });
});
