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
    expect(page).not.toMatch(/>[^<>]*\{e\.record_id\}[^<>]*</); // the id is a filter value, never printed as text
    // ...but it is not gone: an admin copies it for the "Record or object ID" filter (this PR had removed it outright).
    expect(page).toContain('<CopyRecordIdButton id={e.record_id} />');
    expect(page).toContain('aria-label="Copy record ID"');
    expect(page).toContain('navigator.clipboard.writeText(id)');
    expect(page).toContain('auditActorLabel(e.actor_name, e.actor_id, memberName)');
    expect(page).not.toContain('REMOVED_MEMBER_LABEL');
    expect(page).not.toMatch(/removed member|not shown/i);
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
    expect(describeAuditEvent('record.created', { title: 'Plan the launch' })).toMatchObject({ lead: 'Created', name: 'Plan the launch' });
    expect(describeAuditEvent('attachment.added', { filename: 'brief.pdf' })).toMatchObject({ name: 'brief.pdf' });
    expect(describeAuditEvent('relation.linked', { other: { id: 'x', title: 'Acme' } })).toMatchObject({ lead: 'Linked to', name: 'Acme' });
    expect(describeAuditEvent('runner.paired', { object: { kind: 'runner', id: 'x', name: 'Studio laptop' } })).toMatchObject({ name: 'Studio laptop' });
    expect(describeAuditEvent('outward.ai_field', { summary: 'Recomputed Summary' }).detail).toBe('Recomputed Summary');
  });

  it('does not invent a name: a record event with none names its kind of event, and no sentence carries an id', () => {
    const id = '4db75d42-699b-49c9-a34c-4f7631f6782a';
    for (const t of ['record.updated', 'record.deleted', 'record.restored', 'comment.created', 'reference.created', 'document.edited']) {
      const s = describeAuditEvent(t, { target_record_id: id, comment_id: id });
      expect(s.name).toBeNull();
      expect(JSON.stringify(s)).not.toContain(id);
    }
    expect(describeAuditEvent('relation.linked', { relation_id: 'r', other: { id } })).toMatchObject({ lead: 'Records linked', name: null });
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
    for (const p of [null, undefined, 'x', 3, []]) expect(describeAuditEvent('record.created', p).lead).toBe('Record created');
  });
});

/** The sentence as the page prints it: lead, the bold name in curly quotes, tail, then the muted detail after a middle dot. */
const say = (type: string, payload: unknown): string => {
  const s = describeAuditEvent(type, payload);
  return `${s.lead}${s.name ? ` “${s.name}”` : ''}${s.tail}${s.detail ? ` · ${s.detail}` : ''}`;
};

/**
 * Ticket #1287 — the sentences are PINNED, not only present. Every code the API can emit maps to its exact words, so changing "Record
 * moved to Trash" to "Permanently deleted" (which the checks above let through, since they only ask for words) fails here. The codes
 * are derived from the API source by `emittedEventTypes`, so a new code fails until its sentence is written down.
 *
 * No sentence says "a record" where a name should go, and none carries a value it cannot name: the record's title and link need the
 * API (Marek, ticket #1287), and until then a record event states what happened, nothing more.
 */
const named = (name: string) => ({ object: { kind: 'x', id: 'x', name } });
const SENTENCES: Record<string, [payload: unknown, sentence: string]> = {
  'record.created': [{}, 'Record created'],
  'record.updated': [{}, 'Record updated'],
  'record.deleted': [{}, 'Record moved to Trash'],
  'record.restored': [{}, 'Record restored from Trash'],
  'relation.linked': [{}, 'Records linked'],
  'relation.unlinked': [{}, 'Records unlinked'],
  'comment.created': [{}, 'Comment added'],
  'reference.created': [{}, 'Mention added'],
  'document.edited': [{}, 'Description edited'],
  'attachment.added': [{ filename: 'brief.pdf' }, 'Added an attachment “brief.pdf”'],
  'button.pressed': [{ button: 'Send' }, 'Pressed the button “Send”'],
  'portal_recipient.created': [named('Acme'), 'Created a portal link for “Acme”'],
  'portal_recipient.rotated': [named('Acme'), 'Replaced the portal link for “Acme”'],
  'portal_recipient.revoked': [named('Acme'), 'Revoked the portal link for “Acme”'],
  'runner.paired': [named('Studio'), 'Paired the Runner “Studio”'],
  'runner.activated': [named('Studio'), 'Activated the Runner “Studio”'],
  'runner.assigned': [named('Studio'), 'Assigned an agent to the Runner “Studio”'],
  'runner.unassigned': [named('Studio'), 'Removed an agent from the Runner “Studio”'],
  'runner.revoked': [named('Studio'), 'Revoked the Runner “Studio”'],
  'outward.slack_mention_mirror': [{ summary: 'S' }, 'Mirrored a mention to Slack · S'],
  'outward.mention_email': [{ summary: 'S' }, 'Emailed a member about a mention · S'],
  'outward.watcher_email': [{ summary: 'S' }, 'Emailed a watcher about a change · S'],
  'outward.calendar_sync': [{ summary: 'S' }, 'Synced to the calendar · S'],
  'outward.linear_comment': [{ summary: 'S' }, 'Posted a comment to Linear · S'],
  'outward.ai_field': [{ summary: 'S' }, 'Recomputed an AI field · S'],
};
for (const kind of ['space', 'database', 'view']) {
  SENTENCES[`${kind}.deleted`] = [named('X'), `Deleted the ${kind} “X”`];
  SENTENCES[`${kind}.restored`] = [named('X'), `Restored the ${kind} “X”`];
  SENTENCES[`${kind}.purged`] = [named('X'), `Purged the ${kind} “X”`];
  SENTENCES[`${kind}.restricted`] = [named('X'), `Restricted the ${kind} “X”`];
  SENTENCES[`${kind}.unrestricted`] = [named('X'), `Opened the ${kind} “X” to everyone`];
}

describe('every sentence is pinned exactly (#1287)', () => {
  const { types } = emittedEventTypes();

  it('the table covers exactly the codes the API can emit', () => {
    expect(Object.keys(SENTENCES).sort()).toEqual([...types].sort());
  });

  it.each(Object.entries(SENTENCES))('%s', (type, [payload, sentence]) => {
    expect(say(type, payload)).toBe(sentence);
  });

  it('no sentence says "a record" or "(not shown)" in place of a name', () => {
    for (const [type, [payload]] of Object.entries(SENTENCES)) {
      expect(say(type, payload), type).not.toMatch(/\ba record\b|not shown|removed member/i);
    }
  });
});
