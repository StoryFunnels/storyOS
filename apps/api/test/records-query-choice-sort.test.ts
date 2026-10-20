import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './helpers/app';
import { signUpUser } from './helpers/users';
import { call, joinAs } from './helpers/members';
import { optionRank } from '../src/records/query-compiler';

/**
 * #961 — a select / workflow / multi_select sort ordered by the OPTION ID (the stored value): the text of a uuid, so an order
 * nobody chose while the UI said "A → Z". It orders by the option's POSITION now (Low → Urgent, Triage → Done); multi_select
 * by the position of its FIRST selected value (array order, as stored); empty follows `nulls`; ties fall back to the record id.
 *
 * The fixture is built so that id order, label order and position order are ALL different, which is what makes a wrong order
 * visible: options are created Urgent, Low, High, Medium (positions 0..3) and labelled so A→Z is High, Low, Medium, Urgent.
 */
let app: NestFastifyApplication;
let token: string;
let ws: string, db: string, field: string;
let opt: Record<string, string> = {};
const as = (method: string, url: string, payload?: unknown) => call(app, token, method, url, payload);
const rec = (name: string, value?: unknown) => as('POST', `/workspaces/${ws}/databases/${db}/records`, { values: { name, ...(value === undefined ? {} : { prio: value }) } });
const sorted = async (direction: 'asc' | 'desc', extra: Record<string, unknown> = {}, limit = 100) => {
  const res = await as('POST', `/workspaces/${ws}/databases/${db}/records/query`, { sorts: [{ field: 'prio', direction }], limit, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return { names: res.json().data.map((r: { title: string }) => r.title) as string[], next: res.json().next_cursor as string | null };
};

beforeAll(async () => {
  app = await createTestApp();
  token = (await signUpUser(app, 'Choice Sort')).token;
  ws = (await as('POST', '/workspaces', { name: 'Choice Sort WS' })).json().id;
  const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
  db = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: 'Tasks' })).json().id;
  const f = (await as('POST', `/workspaces/${ws}/databases/${db}/fields`, {
    display_name: 'Prio', type: 'select',
    options: [{ label: 'Urgent', color: 'red' }, { label: 'Low', color: 'gray' }, { label: 'High', color: 'orange' }, { label: 'Medium', color: 'blue' }],
  })).json();
  field = f.id;
  opt = Object.fromEntries((f.options as Array<{ id: string; label: string }>).map((o) => [o.label, o.id]));
  // one record per option, created in an order that matches none of id / label / position, plus two empty ones
  for (const [name, label] of [['r-medium', 'Medium'], ['r-urgent', 'Urgent'], ['r-high', 'High'], ['r-low', 'Low']] as const) expect((await rec(name, opt[label])).statusCode).toBe(201);
  await rec('r-empty-1');
  await rec('r-empty-2');
}, 240_000);
afterAll(async () => { await app.close(); });

const POSITION_ASC = ['r-urgent', 'r-low', 'r-high', 'r-medium'];

describe('#961 sorting by a select orders by option POSITION', () => {
  it('ascending is option order, not id order and not label order', async () => {
    const { names } = await sorted('asc');
    expect(names.slice(0, 4), `got ${JSON.stringify(names)}`).toEqual(POSITION_ASC);
  });

  it('descending reverses it', async () => {
    const { names } = await sorted('desc');
    expect(names.slice(0, 4)).toEqual([...POSITION_ASC].reverse());
  });

  it('empty values trail by default and lead with nulls: first, in both directions; ties break by record id', async () => {
    for (const direction of ['asc', 'desc'] as const) {
      const last = await sorted(direction);
      expect(last.names.slice(4).sort()).toEqual(['r-empty-1', 'r-empty-2']);
      const first = await sorted(direction, { nulls: 'first' });
      expect(first.names.slice(0, 2).sort()).toEqual(['r-empty-1', 'r-empty-2']);
    }
  });

  it('keyset paging walks the same order with no repeats and no gaps, ascending and descending', async () => {
    for (const direction of ['asc', 'desc'] as const) {
      const whole = (await sorted(direction)).names;
      const walked: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await sorted(direction, cursor ? { cursor } : {}, 2);
        walked.push(...page.names);
        if (!page.next) break;
        cursor = page.next;
      }
      expect(walked, direction).toEqual(whole);
    }
  });

  it('renaming an option keeps its position; reordering options changes the result', async () => {
    const rename = await as('PATCH', `/workspaces/${ws}/databases/${db}/fields/${field}/options/${opt.Urgent}`, { label: 'Zzz urgent' });
    expect(rename.statusCode, rename.body).toBe(200);
    expect((await sorted('asc')).names.slice(0, 4), 'a rename must not move it').toEqual(POSITION_ASC);
    // move Medium to the front: it becomes the first option
    const move = await as('PATCH', `/workspaces/${ws}/databases/${db}/fields/${field}/options/${opt.Medium}`, { position: -1 });
    expect(move.statusCode, move.body).toBe(200);
    expect((await sorted('asc')).names.slice(0, 4)).toEqual(['r-medium', 'r-urgent', 'r-low', 'r-high']);
  });
});

describe('#961 workflow and multi_select follow the same order', () => {
  async function freshDb(type: 'workflow' | 'multi_select', labels: string[]) {
    const space = (await as('GET', `/workspaces/${ws}/spaces`)).json()[0].id;
    const d = (await as('POST', `/workspaces/${ws}/databases`, { space_id: space, name: `Sort ${type} ${Math.random().toString(36).slice(2)}` })).json().id as string;
    const f = (await as('POST', `/workspaces/${ws}/databases/${d}/fields`, { display_name: 'Prio', type, options: labels.map((label) => ({ label, color: 'gray' })) })).json();
    const ids = Object.fromEntries((f.options as Array<{ id: string; label: string }>).map((o) => [o.label, o.id])) as Record<string, string>;
    const add = (name: string, value?: unknown) => as('POST', `/workspaces/${ws}/databases/${d}/records`, { values: { name, ...(value === undefined ? {} : { prio: value }) } });
    const q = async (direction: 'asc' | 'desc', extra: Record<string, unknown> = {}, limit = 100) => {
      const res = await as('POST', `/workspaces/${ws}/databases/${d}/records/query`, { sorts: [{ field: 'prio', direction }], limit, ...extra });
      expect(res.statusCode, res.body).toBe(201);
      return { names: res.json().data.map((r: { title: string }) => r.title) as string[], next: res.json().next_cursor as string | null };
    };
    return { d, ids, add, q };
  }

  it('workflow: Triage → Done order, whatever the ids and labels', async () => {
    const { ids, add, q } = await freshDb('workflow', ['Triage', 'Backlog', 'Doing', 'Done']);
    for (const [name, label] of [['r-done', 'Done'], ['r-triage', 'Triage'], ['r-doing', 'Doing'], ['r-backlog', 'Backlog']] as const) await add(name, ids[label]);
    expect((await q('asc')).names).toEqual(['r-triage', 'r-backlog', 'r-doing', 'r-done']);
    expect((await q('desc')).names).toEqual(['r-done', 'r-doing', 'r-backlog', 'r-triage']);
  });

  it('multi_select: by the rank of the FIRST stored value; empty trails; paging walks the same order', async () => {
    const { ids, add, q } = await freshDb('multi_select', ['Red', 'Green', 'Blue']);
    await add('m-blue-red', [ids.Blue, ids.Red]); // first value Blue (rank 3)
    await add('m-red-blue', [ids.Red, ids.Blue]); // first value Red (rank 1)
    await add('m-green', [ids.Green]); // rank 2
    await add('m-none');
    const asc = (await q('asc')).names;
    expect(asc, JSON.stringify(asc)).toEqual(['m-red-blue', 'm-green', 'm-blue-red', 'm-none']);
    expect((await q('desc')).names).toEqual(['m-blue-red', 'm-green', 'm-red-blue', 'm-none']);
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const page = await q('asc', cursor ? { cursor } : {}, 1);
      walked.push(...page.names);
      if (!page.next) break;
      cursor = page.next;
    }
    expect(walked).toEqual(asc);
  });

  it('a guest with a database grant gets the same order (the narrowed query surface rebuilds field definitions)', async () => {
    const { d, ids, add } = await freshDb('workflow', ['First', 'Second', 'Third']);
    for (const [name, label] of [['g-third', 'Third'], ['g-first', 'First'], ['g-second', 'Second']] as const) await add(name, ids[label]);
    const guest = await joinAs(app, token, ws, 'Choice Guest', 'guest', [{ database_id: d, role: 'viewer' }]);
    const res = await call(app, guest.token, 'POST', `/workspaces/${ws}/databases/${d}/records/query`, { sorts: [{ field: 'prio', direction: 'asc' }], limit: 10 });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.map((r: { title: string }) => r.title)).toEqual(['g-first', 'g-second', 'g-third']);
  });
});

describe('#961 optionRank', () => {
  it('is 1-based, and null for a missing or non-string value', () => {
    expect(optionRank(['a', 'b'], 'b')).toBe(2);
    expect(optionRank(['a', 'b'], 'zzz')).toBeNull();
    expect(optionRank(['a'], undefined)).toBeNull();
    expect(optionRank(undefined, 'a')).toBeNull();
  });
});
