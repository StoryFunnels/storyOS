import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReuseChoice, ReuseManyView, ReuseNone } from '@/components/pack-reuse-choice';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REUSE_COPY,
  addRefusals,
  aDatabase,
  anArticle,
  applyRefusals,
  cantUseLine,
  droppedPicks,
  noDatabaseMessage,
  refusalNotice,
  reuseRefusals,
  shortReason,
  type RefusedCandidates,
  existingChoices,
  isGoneReason,
  isReusableCandidate,
  isStalePick,
  manyChoices,
  noneUsableLine,
  pickedCandidate,
  reuseNote,
  reuseResolutions,
  reuseView,
  reusedLabels,
  reusedNames,
  singleReusable,
  type ExistingElsewhere,
  type ReuseCandidate,
} from './pack-review';

/** The shape the API returns (ticket #1176, PR #1392), JCM's real Issues: two usable, one type clash, two Linear mirrors. */
const LINEAR =
  'This Issues database is synced from Linear, which rewrites its State, Priority and Estimate on every sync, so a pack cannot be added to it. Create a new one here.';
const cand = (over: Partial<ReuseCandidate> & { database_id: string; space_name: string }): ReuseCandidate => ({ reusable: true, ...over });
const storyos = cand({ database_id: 'db-storyos', space_name: 'StoryOS', record_count: 1172, fields_added: [{ name: 'Labels', type: 'multi_select' }, { name: 'Estimate', type: 'number' }, { name: 'Due date', type: 'date' }] });
const audit = cand({ database_id: 'db-audit', space_name: 'Website Audit', record_count: 1, fields_added: [] });
const tool = cand({ database_id: 'db-tool', space_name: 'The Tool', reusable: false, reason: 'Estimate is a select here but this pack needs a number.' });
const eng = cand({ database_id: 'db-eng', space_name: 'Engineering (Linear)', reusable: false, reason: LINEAR });
const sf = cand({ database_id: 'db-sf', space_name: 'StoryFunnels (Linear)', reusable: false, reason: LINEAR });

const several = (candidates: ReuseCandidate[]): ExistingElsewhere => ({
  adopted: false,
  reusable: false,
  reason: "Can't use one: you have more than one Issues database. Create a new one here.",
  candidates,
});
const issues = several([storyos, audit, tool, eng, sf]);
const noop = () => {};

describe('reuseView — which row is drawn (ticket #1176)', () => {
  it('several, some usable: many, with the usable ones and the rest apart (a non-reusable one is NEVER in the list)', () => {
    const v = reuseView(issues);
    expect(v.kind).toBe('many');
    if (v.kind !== 'many') return;
    expect(v.usable.map((c) => c.space_name)).toEqual(['StoryOS', 'Website Audit']);
    expect(v.unusable.map((c) => c.space_name)).toEqual(['Engineering (Linear)', 'StoryFunnels (Linear)', 'The Tool']);
    expect(v.total).toBe(5);
  });
  it('the order is the same on every open, whatever order the server answered in: fullest first, the rest by space', () => {
    const a = reuseView(several([audit, tool, storyos, sf, eng]));
    const b = reuseView(several([eng, sf, storyos, tool, audit]));
    expect(a).toEqual(b);
    if (a.kind !== 'many') throw new Error('fixture');
    expect(a.usable.map((c) => c.space_name)).toEqual(['StoryOS', 'Website Audit']);
    expect(a.unusable.map((c) => c.space_name)).toEqual(['Engineering (Linear)', 'StoryFunnels (Linear)', 'The Tool']);
  });
  it('several, none usable: none (no radios at all)', () => {
    const v = reuseView(several([eng, sf]));
    expect(v.kind).toBe('none');
  });
  it('one candidate, with the old fields present: the single-candidate row, driven by the old fields as before', () => {
    const hint: ExistingElsewhere = { database_id: 'db-1', space_name: 'Agency OS', adopted: false, reusable: true, candidates: [{ ...storyos, database_id: 'db-1' }] };
    const v = reuseView(hint);
    expect(v).toEqual({ kind: 'single', hint });
  });
  it('one candidate and a hint that lost its fields (an older server): filled from the candidate, nothing invented', () => {
    const v = reuseView({ adopted: false, reusable: false, candidates: [storyos] });
    expect(v.kind).toBe('single');
    if (v.kind === 'single') expect(v.hint).toMatchObject({ database_id: 'db-storyos', space_name: 'StoryOS', reusable: true });
  });
  it('no candidates field at all (an API from before #1176): the single row, exactly as it was', () => {
    const hint: ExistingElsewhere = { adopted: false, reusable: false, reason: 'Can’t use one: …' };
    expect(reuseView(hint)).toEqual({ kind: 'single', hint });
  });
  it('isReusableCandidate mirrors the server verdict and refuses one it cannot send', () => {
    expect(isReusableCandidate(storyos)).toBe(true);
    expect(isReusableCandidate(tool)).toBe(false);
    expect(isReusableCandidate({ ...storyos, database_id: '' })).toBe(false);
  });
});

describe('a pick sends its database_id — on the preview AND the install (one builder)', () => {
  const choices = existingChoices([{ name: 'Issues', existing_elsewhere: issues }]);
  it('DEFAULT is create new: nothing sent', () => {
    expect(reuseResolutions(choices, {})).toEqual({});
    expect(reuseResolutions(choices, { Issues: { use: false, databaseId: 'db-storyos' } })).toEqual({});
    expect(reusedLabels(choices, {})).toEqual([]);
  });
  it('picking one sends exactly that id', () => {
    expect(reuseResolutions(choices, { Issues: { use: true, databaseId: 'db-audit' } })).toEqual({ Issues: { action: 'reuse', database_id: 'db-audit' } });
    expect(reusedNames(choices, { Issues: { use: true, databaseId: 'db-audit' } })).toEqual(['Issues']);
  });
  it('"use" with no id yet means the first usable one (the list opens preselected)', () => {
    expect(reuseResolutions(choices, { Issues: { use: true } })).toEqual({ Issues: { action: 'reuse', database_id: 'db-storyos' } });
  });
  it('a non-reusable candidate can never be sent, whatever the state says', () => {
    for (const id of ['db-tool', 'db-eng', 'db-sf']) expect(reuseResolutions(choices, { Issues: { use: true, databaseId: id } })).toEqual({});
  });
  it('a pick that is not a candidate at all is not sent (stale)', () => {
    expect(reuseResolutions(choices, { Issues: { use: true, databaseId: 'gone' } })).toEqual({});
  });
  it('a none-usable row can never be sent', () => {
    const none = existingChoices([{ name: 'Sprints', existing_elsewhere: several([eng, sf]) }]);
    expect(reuseResolutions(none, { Sprints: { use: true, databaseId: 'db-eng' } })).toEqual({});
  });
  it('the one-candidate row still sends NO id: single-candidate reuse is unchanged', () => {
    const one = existingChoices([{ name: 'Clients', existing_elsewhere: { database_id: 'db-1', space_name: 'A', adopted: false, reusable: true, candidates: [{ ...storyos, database_id: 'db-1' }] } }]);
    expect(reuseResolutions(one, { Clients: { use: true } })).toEqual({ Clients: { action: 'reuse' } });
  });
  it('manyChoices / singleReusable split the rows: only a single reusable one is asked "as if reused"', () => {
    const mixed = existingChoices([
      { name: 'Issues', existing_elsewhere: issues },
      { name: 'Sprints', existing_elsewhere: several([eng, sf]) },
      { name: 'Clients', existing_elsewhere: { database_id: 'db-1', space_name: 'A', adopted: false, reusable: true } },
      { name: 'Contacts', existing_elsewhere: { database_id: 'db-2', space_name: 'B', adopted: false, reusable: false, reason: 'x' } },
    ]);
    expect(manyChoices(mixed).map((c) => c.name)).toEqual(['Issues']);
    expect(singleReusable(mixed).map((c) => c.name)).toEqual(['Clients']);
  });
  it('the bottom note names the picked one with its space (Dara)', () => {
    expect(reuseNote(reusedLabels(choices, { Issues: { use: true, databaseId: 'db-storyos' } }))).toBe(
      'Uses your existing Issues (in StoryOS) from another space. Everything else is new, and nothing you have is removed.',
    );
  });
});

describe('stale picks fall back (unconfigured is not invalid)', () => {
  const v = reuseView(issues);
  it('a pick the list no longer offers is stale, and is not an error', () => {
    expect(isStalePick(v, { use: true, databaseId: 'gone' })).toBe(true);
    expect(isStalePick(v, { use: true, databaseId: 'db-audit' })).toBe(false);
    expect(isStalePick(v, { use: false })).toBe(false);
    expect(isStalePick(v, undefined)).toBe(false);
    if (v.kind === 'many') expect(pickedCandidate(v, { use: true, databaseId: 'gone' })).toBeNull();
  });
  it('the confirming preview data drops what the server does not adopt, and keeps what it does', () => {
    const picks = { Issues: { database_id: 'db-audit' }, Projects: { database_id: 'p' } };
    expect(
      droppedPicks(picks, [
        { name: 'Issues', existing_elsewhere: { adopted: true, reusable: true } },
        { name: 'Projects', existing_elsewhere: { adopted: false, reusable: false, reason: 'Budget is a text here but this pack needs a number.' } },
      ]),
    ).toEqual([{ name: 'Projects', databaseId: 'p', kind: 'refused', reason: 'Budget is a text here but this pack needs a number.' }]);
    expect(droppedPicks(picks, []).map((r) => [r.name, r.kind])).toEqual([['Issues', 'gone'], ['Projects', 'gone']]);
  });
  it('CONFIRMING PREVIEW + GONE: the server answers 201 with the "no database you can edit" sentence as the reason; that is GONE, not a reason of the pack’s own (Vera)', () => {
    const picks = { Issues: { database_id: 'db-audit' } };
    const preview = [{ name: 'Issues', existing_elsewhere: { adopted: false, reusable: false, reason: 'There is no Issues database you can edit.' } }];
    expect(droppedPicks(picks, preview)).toEqual([{ name: 'Issues', databaseId: 'db-audit', kind: 'gone' }]);
    // what the dialog then shows: the same sentence as the 422 paths, the deleted database off the list AND off the can't-be-used line
    const choices = existingChoices([{ name: 'Issues', existing_elsewhere: issues }]);
    const refusals = droppedPicks(picks, preview);
    const next = applyRefusals(choices, addRefusals({}, refusals));
    const view = reuseView(next[0]!.hint);
    if (view.kind !== 'many') throw new Error('fixture');
    expect(view.usable.map((c) => c.database_id)).toEqual(['db-storyos']);
    expect(view.unusable.map((c) => c.database_id)).not.toContain('db-audit');
    expect(cantUseLine(view.unusable)).not.toContain('Website Audit');
    const notice = refusalNotice(refusals[0]!);
    expect(notice).toBe('That Issues database is gone or you can no longer reach it, so this pack will make a new one.');
    expect(notice).not.toContain('can’t take this pack now');
  });
  it('a real own reason on the confirming preview keeps the "can’t take this pack now" wording and the can’t-be-used line', () => {
    const refusals = droppedPicks({ Issues: { database_id: 'db-audit' } }, [
      { name: 'Issues', existing_elsewhere: { adopted: false, reusable: false, reason: 'Priority is a text here but this pack needs a select.' } },
    ]);
    expect(refusals[0]!.kind).toBe('refused');
    expect(refusalNotice(refusals[0]!)).toContain('can’t take this pack now: Priority is a text here but this pack needs a select');
    const next = applyRefusals(existingChoices([{ name: 'Issues', existing_elsewhere: issues }]), addRefusals({}, refusals));
    const view = reuseView(next[0]!.hint);
    if (view.kind !== 'many') throw new Error('fixture');
    expect(cantUseLine(view.unusable)).toContain('Website Audit (Priority is a text here but this pack needs a select)');
  });
  it('isGoneReason is the one test for the "no such database" sentence, name-aware, on every path', () => {
    expect(isGoneReason('Issues', 'There is no Issues database you can edit.')).toBe(true);
    expect(isGoneReason('Issues', '  There is no Issues database you can edit.  ')).toBe(true);
    expect(isGoneReason('Issues', 'There is no Projects database you can edit.')).toBe(false);
    expect(isGoneReason('Issues', 'Priority is a text here but this pack needs a select.')).toBe(false);
    expect(isGoneReason('Issues', undefined)).toBe(false);
  });
  it('says why in one sentence (Dara): the name follows the database', () => {
    expect(REUSE_COPY.stalePick('Issues')).toBe('That Issues database is gone or you can no longer reach it, so this pack will make a new one.');
    expect(REUSE_COPY.stalePick('Sprints')).toBe('That Sprints database is gone or you can no longer reach it, so this pack will make a new one.');
  });
});

/** The exact 422 body the API sends for a picked id that is not a candidate (apps/api/test/pack-reuse-candidates.test.ts pins the sentence). */
const goneBody = (name: string) => ({ error: { code: 'validation_failed', message: noDatabaseMessage(name), request_id: 'r' } });

describe('a 422 on a reuse pick — on EVERY path, the install included (Dara review of PR 1417)', () => {
  const choices = existingChoices([{ name: 'Issues', existing_elsewhere: issues }]);
  const picked = { Issues: { use: true, databaseId: 'db-audit' } };
  const sent = reuseResolutions(choices, picked);

  it('the "no database you can edit" 422 is a gone refusal, naming the database that was sent', () => {
    expect(reuseRefusals(goneBody('Issues'), sent)).toEqual([{ name: 'Issues', databaseId: 'db-audit', kind: 'gone' }]);
    expect(noDatabaseMessage('Issues')).toBe('There is no Issues database you can edit.');
  });
  it('a 422 with a reason of its own is that pick’s refusal, with the reason (one pick)', () => {
    const body = { error: { code: 'validation_failed', message: 'Priority is a text here but this pack needs a select.' } };
    expect(reuseRefusals(body, sent)).toEqual([{ name: 'Issues', databaseId: 'db-audit', kind: 'refused', reason: 'Priority is a text here but this pack needs a select.' }]);
  });
  it('the reason may arrive in details, as the API puts per-value messages', () => {
    const body = { error: { code: 'validation_failed', message: 'x', details: [{ message: noDatabaseMessage('Issues') }] } };
    expect(reuseRefusals(body, sent).map((r) => r.kind)).toEqual(['gone']);
  });
  it('is not a refusal when it is not a 422, has no pick behind it, or the message is unrelated with several picks', () => {
    expect(reuseRefusals({ error: { code: 'forbidden', message: noDatabaseMessage('Issues') } }, sent)).toEqual([]);
    expect(reuseRefusals({ error: { code: 'internal_error', message: 'boom' } }, sent)).toEqual([]);
    expect(reuseRefusals(goneBody('Issues'), {})).toEqual([]);
    expect(reuseRefusals(undefined, sent)).toEqual([]);
    expect(reuseRefusals({ error: { code: 'validation_failed', message: 'Something else.' } }, { Issues: { database_id: 'a' }, Projects: { database_id: 'b' } })).toEqual([]);
  });
  it('with several picks only the one the sentence names is refused', () => {
    const picks = { Issues: { database_id: 'a' }, Projects: { database_id: 'b' } };
    expect(reuseRefusals(goneBody('Projects'), picks).map((r) => r.name)).toEqual(['Projects']);
  });

  /** What the dialog does on a refusal, as pure state: drop the pick, remember the refusal, apply it to the choices. */
  const afterRefusal = (body: unknown) => {
    const refusals = reuseRefusals(body, sent);
    const refused: RefusedCandidates = addRefusals({}, refusals);
    const next = applyRefusals(choices, refused);
    const selection = Object.fromEntries(Object.entries(picked).filter(([n]) => !refusals.some((r) => r.name === n)));
    const notice = refusals.map(refusalNotice)[0] ?? null;
    return { refusals, next, selection, notice };
  };

  it('INSTALL path: the dead pick is no longer selected, no longer in the list, nothing is sent for it, and the sentence shows', () => {
    const { next, selection, notice } = afterRefusal(goneBody('Issues'));
    expect(reuseResolutions(next, selection)).toEqual({});
    expect(reusedNames(next, selection)).toEqual([]);
    const view = reuseView(next[0]!.hint);
    if (view.kind !== 'many') throw new Error('three candidates are left: a many row');
    expect(view.usable.map((c) => c.database_id)).toEqual(['db-storyos']);
    expect(view.total).toBe(4);
    const html = renderToStaticMarkup(createElement(ReuseChoice, { ws: 'w', choice: next[0]!, newSpace: 'Dev Tracker', pick: selection.Issues, adds: undefined, notice, onPick: noop }));
    expect(html).toContain('That Issues database is gone or you can no longer reach it, so this pack will make a new one.');
    expect(html).not.toContain('db-audit');
    expect(html).not.toContain('Issues in Website Audit');
    expect(html).toMatch(/checked=""\/><span class="flex min-w-0 flex-col"><b[^>]*>Create a new Issues database here/);
    expect(html).not.toContain('pack-reuse-pick');
  });
  it('PREVIEW path: the same refusal from the confirming preview gives the same state', () => {
    // the confirming preview throws the same body the install does, and the dialog runs both through reuseRefusals
    expect(afterRefusal(goneBody('Issues')).refusals).toEqual(reuseRefusals(goneBody('Issues'), sent));
  });
  it('a refusal WITH a reason moves the candidate to the can’t-be-used line instead of deleting it', () => {
    const reason = 'Priority is a text here but this pack needs a select.';
    const { next, notice } = afterRefusal({ error: { code: 'validation_failed', message: reason } });
    const view = reuseView(next[0]!.hint);
    if (view.kind !== 'many') throw new Error('fixture');
    expect(view.usable.map((c) => c.database_id)).toEqual(['db-storyos']);
    expect(view.unusable.map((c) => c.space_name)).toContain('Website Audit');
    expect(cantUseLine(view.unusable)).toContain('Website Audit (Priority is a text here but this pack needs a select)');
    expect(notice).toBe('That Issues database can’t take this pack now: Priority is a text here but this pack needs a select. This pack will make a new one.');
  });
  it('a refused database does not come back when the preview refetches the same candidates', () => {
    const refused = addRefusals({}, reuseRefusals(goneBody('Issues'), sent));
    const again = applyRefusals(existingChoices([{ name: 'Issues', existing_elsewhere: issues }]), refused);
    expect(JSON.stringify(again)).not.toContain('db-audit');
  });
  it('when every candidate is gone the row keeps only its sentence, not a disabled radio with a stale reason', () => {
    const two = existingChoices([{ name: 'Issues', existing_elsewhere: several([storyos, audit]) }]);
    const refused = addRefusals(addRefusals({}, [{ name: 'Issues', databaseId: 'db-storyos', kind: 'gone' }]), [{ name: 'Issues', databaseId: 'db-audit', kind: 'gone' }]);
    const next = applyRefusals(two, refused);
    expect(next[0]!.exhausted).toBe(true);
    const html = renderToStaticMarkup(createElement(ReuseChoice, { ws: 'w', choice: next[0]!, newSpace: 'S', pick: undefined, adds: undefined, notice: REUSE_COPY.stalePick('Issues'), onPick: noop }));
    expect(html).toContain('gone or you can no longer reach it');
    expect(html).not.toContain('type="radio"');
    expect(html).not.toContain('Can&#x27;t use one');
  });
  it('one candidate left and usable: the row becomes the single-candidate two-card row, with the sentence above', () => {
    const two = existingChoices([{ name: 'Issues', existing_elsewhere: several([storyos, audit]) }]);
    const next = applyRefusals(two, addRefusals({}, [{ name: 'Issues', databaseId: 'db-audit', kind: 'gone' }]));
    expect(reuseView(next[0]!.hint).kind).toBe('single');
    expect(next[0]!.exhausted).toBe(false);
  });
  it('wiring: BOTH the confirming preview and the install classify their error with reuseRefusals (guard on the dialog source)', () => {
    const dialog = readFileSync(join(__dirname, '../components/pack-install-dialog.tsx'), 'utf8');
    expect(dialog).toContain('refuse(reuseRefusals(confirmPicks.error, manyPicks))');
    expect(dialog).toMatch(/onError: \(e\) => \{[\s\S]*reuseRefusals\(e, manyPicks\)[\s\S]*if \(refuse\(refusals\)\)[\s\S]*return;/);
  });
});

describe('shortReason — one candidate’s reason inside the brackets (pure)', () => {
  it('the Linear reason, as the API words it today, shortens to "syncs from Linear" (this pins the web side of that wording)', () => {
    expect(shortReason(LINEAR)).toBe('syncs from Linear');
  });
  it('a type clash is the API sentence as given, without its full stop', () => {
    expect(shortReason('Priority is a text here but this pack needs a select.')).toBe('Priority is a text here but this pack needs a select');
  });
  it('drops the API’s trailing advice, which the row already offers', () => {
    expect(shortReason('Something is off. Create a new one here.')).toBe('Something is off');
  });
  it('an unknown reason is used as given; no reason claims nothing specific', () => {
    expect(shortReason('A brand new refusal')).toBe('A brand new refusal');
    expect(shortReason(undefined)).toBe('it can’t take this pack');
    expect(shortReason('')).toBe('it can’t take this pack');
  });
});

describe('the lines (Dara copy, ticket #1176)', () => {
  it('can’t be used: EACH one carries its own bracketed reason, and there is no trailing Linear sentence (Dara)', () => {
    expect(cantUseLine([eng, sf, tool])).toBe(
      '3 can’t be used: Engineering (Linear) (syncs from Linear), StoryFunnels (Linear) (syncs from Linear), The Tool (Estimate is a select here but this pack needs a number).',
    );
    expect(cantUseLine([eng, sf, tool])).not.toContain('The Linear ones sync from Linear');
  });
  it('one mirror among type clashes does not drag a Linear sentence onto the others, and shows its own reason', () => {
    const line = cantUseLine([tool, eng])!;
    expect(line).toContain('Engineering (Linear) (syncs from Linear)');
    expect(line).not.toMatch(/Linear ones/);
  });
  it('one that can’t be used is the same form; none, no line', () => {
    expect(cantUseLine([tool])).toBe('1 can’t be used: The Tool (Estimate is a select here but this pack needs a number).');
    expect(cantUseLine([eng])).toBe('1 can’t be used: Engineering (Linear) (syncs from Linear).');
    expect(cantUseLine([])).toBeNull();
  });
  it('none usable: one quiet line', () => {
    expect(noneUsableLine('Sprints', [eng, sf])).toBe('You have 2 Sprints databases, but both sync from Linear, so this pack makes its own.');
    expect(noneUsableLine('Sprints', [eng, sf, { ...sf, database_id: 'x' }])).toBe('You have 3 Sprints databases, but all sync from Linear, so this pack makes its own.');
    expect(noneUsableLine('Sprints', [tool, eng])).toBe('You have 2 Sprints databases, but none can take this pack, so this pack makes its own.');
  });
  it('the row copy', () => {
    expect(REUSE_COPY.headingMany('Issues', 5)).toBe('You already have 5 Issues databases in other spaces.');
    expect(REUSE_COPY.heading('Issues')).toBe('You already have an Issues database in another space.');
    expect(REUSE_COPY.heading('Sprints')).toBe('You already have a Sprints database in another space.');
    expect(REUSE_COPY.createManyTitle('Issues')).toBe('Create a new Issues database here');
    expect(REUSE_COPY.useManyTitle('Issues')).toBe('Use one of your Issues databases');
    expect(REUSE_COPY.useManySub(2, 'StoryOS')).toBe('2 can take this pack. Pick one below.');
    expect(REUSE_COPY.useManySub(1, 'StoryOS')).toBe('The one in StoryOS.');
    expect(REUSE_COPY.pickLabel('Issues', storyos)).toEqual({ main: 'Issues in StoryOS', count: '· 1,172 records' });
    expect(REUSE_COPY.pickLabel('Issues', audit).count).toBe('· 1 record');
  });
  it('the adds line comes from fields_added', () => {
    expect(REUSE_COPY.pickedAdds({ noun: 'issue', space: 'StoryOS', added: ['Labels', 'Estimate', 'Due date'] })).toBe(
      'Adds Labels, Estimate, Due date to it. Nothing in it is removed or renamed. People who can’t open StoryOS won’t see these issues here.',
    );
    expect(REUSE_COPY.pickedAdds({ noun: 'issue', space: 'W', added: [] })).toContain('It already has every field this pack needs. Nothing in it');
    // unknown is not "nothing": claims no fields line
    expect(REUSE_COPY.pickedAdds({ noun: 'issue', space: 'W', added: undefined })).not.toMatch(/Adds|every field/);
  });
});

describe('anArticle — the article follows the name’s sound, in one helper', () => {
  const table: Array<[string, string]> = [
    ['Issues', 'an'],
    ['Sprints', 'a'],
    ['Epics', 'an'],
    ['Clients', 'a'],
    ['Projects', 'a'],
    ['Orders', 'an'],
    ['Users', 'a'],
    ['Units', 'a'],
    ['Uploads', 'an'],
    ['Updates', 'an'],
    ['Europe offices', 'a'],
    ['One-offs', 'a'],
    ['Hours', 'an'],
    ['Honours', 'an'],
    ['SOPs', 'an'],
    ['FAQs', 'an'],
    ['UI tasks', 'a'],
    ['KPIs', 'a'],
    ['Accounts', 'an'],
    ['', 'a'],
  ];
  for (const [name, art] of table) it(`${JSON.stringify(name)} -> ${art}`, () => expect(anArticle(name)).toBe(art));
  it('builds the phrase', () => {
    expect(aDatabase('Issues')).toBe('an Issues database');
    expect(aDatabase('Sprints')).toBe('a Sprints database');
  });
});

describe('the rendered rows (markup, not source text)', () => {
  const many = (pick: Parameters<typeof ReuseManyView>[0]['pick'], notice: string | null = null) => {
    const v = reuseView(issues);
    if (v.kind !== 'many') throw new Error('fixture');
    return renderToStaticMarkup(createElement(ReuseManyView, { name: "Issues", newSpace: "Dev Tracker", view: v, pick, notice, onPick: noop }));
  };
  it('default: two radios, create new checked, no picker, no adds line, the can’t-use line present', () => {
    const html = many(undefined);
    expect(html).toContain('You already have 5 Issues databases in other spaces.');
    expect(html).toContain('Create a new Issues database here');
    expect(html).toContain('Empty, in Dev Tracker, with the fields this pack needs.');
    expect(html).toContain('2 can take this pack. Pick one below.');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).not.toContain('data-testid="pack-reuse-pick"');
    expect(html).not.toContain('pack-reuse-adds');
    expect(html).toContain('3 can’t be used:');
  });
  it('choosing "use one": the inset list holds ONLY the usable ones, as radios, with their counts', () => {
    const html = many({ use: true, databaseId: 'db-storyos' });
    expect(html.match(/type="radio"/g)).toHaveLength(4);
    expect(html).toContain('Issues in StoryOS');
    expect(html).toContain('· 1,172 records');
    expect(html).toContain('Issues in Website Audit');
    expect(html).toContain('· 1 record');
    // the refused ones are text in the muted line, never a radio
    expect(html).not.toContain('value="db-tool"');
    expect(html).not.toContain('value="db-eng"');
    expect(html).not.toContain('Issues in The Tool');
    expect(html).toContain('Adds Labels, Estimate, Due date to it.');
    expect(html).toContain('People who can’t open StoryOS won’t see these issues here.');
  });
  it('the picked radio is the one checked', () => {
    const html = many({ use: true, databaseId: 'db-audit' });
    expect(html).toMatch(/checked="" value="db-audit"/);
    expect(html).not.toMatch(/checked="" value="db-storyos"/);
    expect(html).toContain('It already has every field this pack needs.');
  });
  it('a stale pick falls back to create new with the sentence, no picker', () => {
    const html = many({ use: true, databaseId: 'gone' }, REUSE_COPY.stalePick('Issues'));
    expect(html).toContain('That Issues database is gone or you can no longer reach it');
    expect(html).not.toContain('pack-reuse-pick');
    expect(html).toMatch(/checked=""\/><span class="flex min-w-0 flex-col"><b[^>]*>Create a new Issues database here/);
  });
  it('none usable: one quiet line and not one radio', () => {
    const v = reuseView(several([eng, sf]));
    if (v.kind !== 'none') throw new Error('fixture');
    const html = renderToStaticMarkup(createElement(ReuseNone, { name: "Sprints", view: v }));
    expect(html).toContain('You have 2 Sprints databases, but both sync from Linear, so this pack makes its own.');
    expect(html).not.toContain('radio');
    expect(html).not.toContain('disabled');
  });
});
