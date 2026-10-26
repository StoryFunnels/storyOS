import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUDIT_TYPE_FILTERS, describeStructuralEvent } from './audit-events';

const obj = (kind: string, name: string) => ({ object: { kind, id: 'x', name } });

describe('structural audit events read as sentences (#1059)', () => {
  it('deleted / restored / restricted / opened to everyone, with the object named', () => {
    expect(describeStructuralEvent('database.deleted', obj('database', 'Leads'))).toMatchObject({ verb: 'deleted', noun: 'database', name: 'Leads' });
    expect(describeStructuralEvent('space.restored', obj('space', 'Client Work'))).toMatchObject({ verb: 'restored', noun: 'space' });
    expect(describeStructuralEvent('view.restricted', obj('view', 'Board'))).toMatchObject({ verb: 'restricted', noun: 'view' });
    expect(describeStructuralEvent('database.unrestricted', obj('database', 'Leads'))).toMatchObject({ verb: 'opened', suffix: ' to everyone' });
    expect(describeStructuralEvent('database.deleted', obj('database', 'Leads'))!.suffix).toBe('');
  });

  it('a space delete names the databases that went with it', () => {
    const e = describeStructuralEvent('space.deleted', { ...obj('space', 'Old'), databases_deleted: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] });
    expect(e!.detail).toBe('Took 2 databases with it: A, B');
    expect(describeStructuralEvent('space.deleted', { ...obj('space', 'Old'), databases_deleted: [{ id: '1', name: 'A' }] })!.detail).toBe('Took 1 database with it: A');
    expect(describeStructuralEvent('space.deleted', { ...obj('space', 'Empty'), databases_deleted: [] })!.detail).toBeNull();
  });

  it('says what else the event carries: restored databases, severed relations, where a view lived', () => {
    expect(describeStructuralEvent('space.restored', { ...obj('space', 'S'), databases_restored: 3 })!.detail).toBe('3 databases came back with it');
    expect(describeStructuralEvent('database.deleted', { ...obj('database', 'D'), severed_relations: 1 })!.detail).toBe('1 relation to it was severed');
    expect(describeStructuralEvent('database.deleted', { ...obj('database', 'D'), severed_relations: 0 })!.detail).toBeNull();
    expect(describeStructuralEvent('view', {})).toBeNull();
    expect(describeStructuralEvent('view.deleted', { ...obj('view', 'V'), database_name: 'Leads' })!.detail).toBe('in the database Leads');
    expect(describeStructuralEvent('view.deleted', { ...obj('view', 'V'), space_name: 'Studio' })!.detail).toBe('in the space Studio');
  });

  it('a name that looks like markup is just text (the caller renders it as a string)', () => {
    expect(describeStructuralEvent('database.deleted', obj('database', '<img src=x onerror=alert(1)>'))!.name).toBe('<img src=x onerror=alert(1)>');
  });

  it('an object with no name, or a payload we cannot read, still renders, and anything else is not structural', () => {
    expect(describeStructuralEvent('database.deleted', {})!.name).toBe('(unnamed)');
    expect(describeStructuralEvent('database.deleted', null)!.name).toBe('(unnamed)');
    for (const t of ['record.created', 'comment.added', 'database', 'foo.bar', undefined, 'space.exploded']) expect(describeStructuralEvent(t, {})).toBeNull();
  });

  // `purged` is not emitted today; if it arrives it is shown as exactly that, never as a claim we make ourselves.
  it('a purged event reads "purged", and nothing here claims a permanent removal', () => {
    expect(describeStructuralEvent('database.purged', obj('database', 'D'))!.verb).toBe('purged');
  });
});

describe('the Type filter (#1059)', () => {
  const values = AUDIT_TYPE_FILTERS.map((f) => f.value);
  it('starts at everything, and the rest are API type lists over all three kinds', () => {
    expect(AUDIT_TYPE_FILTERS[0]).toEqual({ value: '', label: 'All activity' });
    const deleted = AUDIT_TYPE_FILTERS.find((f) => f.label === 'Deleted')!;
    expect(deleted.value.split(',')).toEqual(['space.deleted', 'database.deleted', 'view.deleted']);
    const access = AUDIT_TYPE_FILTERS.find((f) => /Restricted/.test(f.label))!;
    expect(access.value.split(',')).toEqual(['space.restricted', 'space.unrestricted', 'database.restricted', 'database.unrestricted', 'view.restricted', 'view.unrestricted']);
  });
  it('every value fits the API limits: at most 30 types of at most 60 characters each', () => {
    for (const v of values) {
      const list = v ? v.split(',') : [];
      expect(list.length).toBeLessThanOrEqual(30);
      for (const t of list) expect(t.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('the audit-log page (#1059)', () => {
  const page = readFileSync(join(__dirname, '../app/w/[ws]/settings/audit-log/page.tsx'), 'utf8');
  it('no longer says deletions are not captured, and does not claim a permanent purge', () => {
    expect(page).not.toContain('does not yet capture');
    expect(page).not.toMatch(/permanent(ly)?\b/i);
    expect(page).not.toMatch(/purg/i);
  });
  it('sends the type filter and renders structural events through the one describer', () => {
    expect(page).toContain('AUDIT_TYPE_FILTERS');
    expect(page).toContain('describeStructuralEvent');
  });
});
