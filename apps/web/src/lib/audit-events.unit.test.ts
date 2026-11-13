import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AUDIT_PHRASE_TYPES, AUDIT_TYPE_FILTERS, STRUCTURAL_VOCABULARY, describeAuditEvent, describeStructuralEvent } from './audit-events';

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
    expect(page).toContain('describeAuditEvent'); // which renders structural events through describeStructuralEvent (ticket #1287)
  });
  it('(#1287) wears the record Activity source badge, not its own chip, and prints no raw code or id', () => {
    expect(page).toContain("import { SourceBadge } from '@/components/entity/source-badge'");
    expect(page).toContain('<SourceBadge source={e.source} agentName={e.agent_name} inlineName />');
    expect(page).not.toContain('audit-only-this'); // the id is not offered as text or as a control: the record's name needs the API (ticket #1287)
    expect(page).not.toMatch(/>\s*\{e\.source\}\s*</); // the old grey chip printed the source word
    expect(page).not.toMatch(/\{e\.type\}/); // the event code is never the sentence
    expect(page).not.toMatch(/\{e\.record_id\}/); // the id is a filter value, never text
    expect(page).not.toContain('font-mono');
  });
});

// ---- Ticket #1287: every event code the API can emit has a sentence ---------------------------------------------------------------

const API_SRC = fileURLToPath(new URL('../../../api/src/', import.meta.url));

function apiSources(dir = API_SRC): Array<{ file: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return apiSources(full);
    if (!name.endsWith('.ts') || /\.(test|spec)\.ts$/.test(name)) return [];
    return [{ file: full, text: readFileSync(full, 'utf8') }];
  });
}

/** The members of a string-literal array or union written next to `anchor` in `text` (`['a', 'b'] as const` or `'a' | 'b'`). */
function literalsAfter(text: string, anchor: RegExp): string[] {
  const m = anchor.exec(text);
  if (!m) throw new Error(`the API no longer has ${anchor}: this test derives the event vocabulary from it, so update the derivation`);
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/as const;|;\s*\n/);
  return [...rest.slice(0, end).matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
}

/**
 * Every code the API can write to `activity_events.type`, derived from its source, not listed by hand:
 *  - a string literal `type: 'x.y'` anywhere in the API (the writers that spell the code out),
 *  - the relation pair (its writer takes the type as a parameter, so it is a union, not a `type:` literal),
 *  - the four template-built families, expanded from the constants / unions that feed them.
 * A NEW template-built writer fails the family check below until its vocabulary is added here, so it cannot slip past.
 */
function emittedEventTypes(): { types: Set<string>; templates: Set<string> } {
  const srcs = apiSources();
  const types = new Set<string>();
  const templates = new Set<string>();
  for (const { text } of srcs) {
    for (const m of text.matchAll(/\btype: ?'([a-z_]+\.[a-z_]+)'/g)) types.add(m[1]!);
    for (const m of text.matchAll(/'(relation\.(?:un)?linked)'/g)) types.add(m[1]!);
    for (const m of text.matchAll(/\btype: ?`([^`]*)`/g)) templates.add(m[1]!);
  }
  const text = (suffix: string) => srcs.find((s) => s.file.endsWith(suffix))!.text;
  const structural = text('activity/structural-events.ts');
  const kinds = literalsAfter(structural, /STRUCTURAL_KINDS = \[/);
  const actions = literalsAfter(structural, /STRUCTURAL_ACTIONS = \[/);
  for (const k of kinds) for (const a of actions) types.add(`${k}.${a}`);
  for (const a of literalsAfter(structural, /PORTAL_RECIPIENT_ACTIONS = \[/)) types.add(`portal_recipient.${a}`);
  for (const a of literalsAfter(text('runners/runner-present.ts'), /action: /)) types.add(`runner.${a}`);
  for (const c of literalsAfter(text('activity/agent-origin-log.ts'), /export type AgentOutwardChannel =/)) types.add(`outward.${c}`);
  return { types, templates };
}

describe('every audit event code the API can emit has a sentence (#1287)', () => {
  const { types, templates } = emittedEventTypes();

  it('the derivation found the vocabulary (so an empty set cannot pass the checks below)', () => {
    expect(types.size).toBeGreaterThanOrEqual(30);
    for (const t of ['record.created', 'record.updated', 'record.deleted', 'record.restored', 'relation.unlinked', 'comment.created', 'space.deleted', 'view.unrestricted', 'runner.paired', 'outward.ai_field', 'portal_recipient.rotated']) {
      expect(types.has(t), t).toBe(true);
    }
  });

  it('the template-built families are exactly the four this test expands (a fifth must be added to the derivation)', () => {
    expect([...templates].sort()).toEqual(['${event.kind}.${event.action}', 'outward.${input.channel}', 'portal_recipient.${event.action}', 'runner.${event.action}']);
  });

  it('the web knows the same structural kinds and actions as the API', () => {
    const structural = apiSources().find((s) => s.file.endsWith('activity/structural-events.ts'))!.text;
    expect([...STRUCTURAL_VOCABULARY.kinds]).toEqual(literalsAfter(structural, /STRUCTURAL_KINDS = \[/));
    expect([...STRUCTURAL_VOCABULARY.actions]).toEqual(literalsAfter(structural, /STRUCTURAL_ACTIONS = \[/));
  });

  it.each([...types].sort())('%s reads as words, with a case of its own', (type) => {
    const s = describeAuditEvent(type, {});
    expect(s.known).toBe(true);
    expect(s.lead).not.toBe('Something changed');
    expect(s.lead).not.toContain(type);
    expect(s.lead).not.toMatch(/\w\.\w/); // no dotted code
  });

  it('has no case for a code the API cannot emit (a dead case is a claim about something that never happens)', () => {
    const dead = AUDIT_PHRASE_TYPES.filter((t) => !types.has(t));
    expect(dead).toEqual([]);
  });
});

describe('describeAuditEvent: what a sentence keeps and what it refuses to invent (#1287)', () => {
  it('keeps a name the event itself carries', () => {
    expect(describeAuditEvent('record.created', { title: 'Plan the launch' })).toMatchObject({ lead: 'Created a record', name: 'Plan the launch' });
    expect(describeAuditEvent('attachment.added', { filename: 'brief.pdf' })).toMatchObject({ name: 'brief.pdf' });
    expect(describeAuditEvent('relation.linked', { other: { id: 'x', title: 'Acme' } })).toMatchObject({ lead: 'Linked a record to', name: 'Acme' });
    expect(describeAuditEvent('runner.paired', { object: { kind: 'runner', id: 'x', name: 'Studio laptop' } })).toMatchObject({ name: 'Studio laptop' });
    expect(describeAuditEvent('outward.ai_field', { summary: 'Recomputed Summary' }).detail).toBe('Recomputed Summary');
  });

  it('does not invent a name: a record event with none says "a record", and no sentence carries an id', () => {
    const id = '4db75d42-699b-49c9-a34c-4f7631f6782a';
    for (const t of ['record.updated', 'record.deleted', 'record.restored', 'comment.created', 'reference.created', 'document.edited']) {
      const s = describeAuditEvent(t, { target_record_id: id, comment_id: id });
      expect(s.name).toBeNull();
      expect(JSON.stringify(s)).not.toContain(id);
    }
    expect(describeAuditEvent('relation.linked', { relation_id: 'r', other: { id } })).toMatchObject({ lead: 'Linked two records', name: null });
    expect(describeAuditEvent('record.created', {}).name).toBeNull();
    expect(describeAuditEvent('button.pressed', { button: '  ' }).lead).toBe('Pressed a button');
  });

  it('a structural event is still a sentence with the object named, capitalised for its own column', () => {
    expect(describeAuditEvent('database.deleted', obj('database', 'Leads'))).toMatchObject({ lead: 'Deleted the database', name: 'Leads', known: true });
    expect(describeAuditEvent('database.unrestricted', obj('database', 'Leads'))).toMatchObject({ lead: 'Opened the database', tail: ' to everyone' });
    expect(describeAuditEvent('view.deleted', { ...obj('view', 'V'), database_name: 'Leads' }).detail).toBe('in the database Leads');
  });

  it('an unknown code is "Something changed" with the code as muted detail, never the code as the sentence', () => {
    expect(describeAuditEvent('invoice.exploded', { a: 1 })).toEqual({ lead: 'Something changed', name: null, tail: '', detail: 'invoice.exploded', known: false });
    expect(describeAuditEvent(undefined, {})).toMatchObject({ lead: 'Something changed', detail: null, known: false });
    expect(describeAuditEvent('space.exploded', {})).toMatchObject({ known: false });
  });

  it('survives a payload that is not an object', () => {
    for (const p of [null, undefined, 'x', 3, []]) expect(describeAuditEvent('record.created', p).lead).toBe('Created a record');
  });
});
