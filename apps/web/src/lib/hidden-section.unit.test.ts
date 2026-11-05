import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hiddenSectionModel, hiddenSectionOpenKey, placeHref, readHiddenSectionOpen } from './hidden-section';

/**
 * Ticket #1211 — the sidebar's Hidden section and where a search result for a place goes.
 *
 * Access is the API's job (the door is `visibleSpaceIds` + `canSeePersonal`, never `assertSpace`); this model only narrows
 * what the API returned. So the guest/member/admin cases below feed it the list THAT person's API call returns (the
 * `spaces` fixtures are per person) and assert nothing outside it can appear. The API half has its own GUEST fixture:
 * apps/api/test/search-space-door.test.ts.
 */
const sp = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, personal: false, ...extra });
const db = (id: string, spaceId: string, extra: Record<string, unknown> = {}) => ({ id, spaceId, name: id, ...extra });
const none = () => false;
const hiding = (...keys: string[]) => (kind: 'space' | 'database', id: string) => keys.includes(`${kind}:${id}`);

// Agentic OS: a space whose ONLY content is the three is_system agent databases.
const AGENTIC = sp('agentic-os');
const AGENTIC_DBS = [
  db('agents', 'agentic-os', { name: 'Agents', isSystem: true }),
  db('runs', 'agentic-os', { name: 'Runs', isSystem: true }),
  db('triggers', 'agentic-os', { name: 'Agent triggers', isSystem: true }),
];
const SALES = sp('sales');
const OPS = sp('ops');

describe('hiddenSectionModel', () => {
  it('lists a system-only space and a space this person hid; a visible space is not listed', () => {
    const m = hiddenSectionModel({
      spaces: [AGENTIC, SALES, OPS],
      databases: [...AGENTIC_DBS, db('deals', 'sales')],
      isHidden: hiding('space:ops'),
      systemOnlySpaceIds: new Set(['agentic-os']),
    });
    expect(m.spaces.map((s) => [s.space.id, s.reason])).toEqual([
      ['agentic-os', 'system'],
      ['ops', 'mine'],
    ]);
    expect(m.spaces.map((s) => s.space.id)).not.toContain('sales');
    expect(m.count).toBe(2);
  });

  it('a space that is NOT system-only is not listed because it has system databases in it (identity is what the space holds, reported by its row)', () => {
    const m = hiddenSectionModel({
      spaces: [AGENTIC],
      databases: AGENTIC_DBS,
      isHidden: none,
      systemOnlySpaceIds: new Set(), // its own row found a document in it: it stays in the main list
    });
    expect(m.spaces).toEqual([]);
    expect(m.count).toBe(0);
  });

  it('a space that is both system-only and hidden by the person is listed once, as system', () => {
    const m = hiddenSectionModel({
      spaces: [AGENTIC],
      databases: AGENTIC_DBS,
      isHidden: hiding('space:agentic-os'),
      systemOnlySpaceIds: new Set(['agentic-os']),
    });
    expect(m.spaces).toHaveLength(1);
    expect(m.spaces[0]?.reason).toBe('system');
  });

  it('a database hidden alone is listed; one inside an already-hidden space is not listed twice; the system databases never are', () => {
    const m = hiddenSectionModel({
      spaces: [AGENTIC, SALES, OPS],
      databases: [...AGENTIC_DBS, db('deals', 'sales'), db('tasks', 'ops')],
      isHidden: hiding('database:deals', 'database:tasks', 'space:ops', 'database:agents'),
      systemOnlySpaceIds: new Set(['agentic-os']),
    });
    expect(m.databases.map((d) => d.id)).toEqual(['deals']);
  });

  it('the personal space is never listed, hidden or not (it has its own section and is private)', () => {
    const mine = sp('my-space', { personal: true });
    const m = hiddenSectionModel({
      spaces: [mine, SALES],
      databases: [],
      isHidden: hiding('space:my-space'),
      systemOnlySpaceIds: new Set(['my-space']),
    });
    expect(m.spaces).toEqual([]);
  });

  describe('access: only spaces the API let this person see', () => {
    // What each person's GET /spaces returns in a workspace where Agentic OS is open, Ops is restricted, and the guest holds
    // a grant on ONE database inside Sales.
    const apiList = { admin: [AGENTIC, SALES, OPS], member: [AGENTIC, SALES], guest: [SALES] };

    it('admin sees Agentic OS and the space they hid, in Hidden', () => {
      const m = hiddenSectionModel({ spaces: apiList.admin, databases: [], isHidden: hiding('space:ops'), systemOnlySpaceIds: new Set(['agentic-os']) });
      expect(m.spaces.map((s) => s.space.id)).toEqual(['agentic-os', 'ops']);
    });

    it('a member never gets the restricted space, even one they somehow hid earlier (their API list does not have it)', () => {
      const m = hiddenSectionModel({ spaces: apiList.member, databases: [], isHidden: hiding('space:ops'), systemOnlySpaceIds: new Set(['agentic-os']) });
      expect(m.spaces.map((s) => s.space.id)).toEqual(['agentic-os']);
    });

    it('a GUEST with a database grant in Sales gets nothing that is not theirs: no Agentic OS, no restricted space, no stale local state', () => {
      // A stale hidden key and a stale "system-only" report for spaces the guest cannot open change nothing.
      const m = hiddenSectionModel({
        spaces: apiList.guest,
        databases: [db('deals', 'sales')],
        isHidden: hiding('space:ops', 'space:agentic-os'),
        systemOnlySpaceIds: new Set(['agentic-os']),
      });
      expect(m.spaces).toEqual([]);
      expect(m.count).toBe(0);
    });

    it('a guest who hid the one space they can see gets exactly that space', () => {
      const m = hiddenSectionModel({ spaces: apiList.guest, databases: [], isHidden: hiding('space:sales'), systemOnlySpaceIds: new Set() });
      expect(m.spaces.map((s) => s.space.id)).toEqual(['sales']);
    });
  });
});

describe('collapsed by default', () => {
  it('is closed unless this person opened it', () => {
    expect(readHiddenSectionOpen(null)).toBe(false);
    expect(readHiddenSectionOpen('0')).toBe(false);
    expect(readHiddenSectionOpen('1')).toBe(true);
  });

  it('the remembered state is per workspace', () => {
    expect(hiddenSectionOpenKey('a')).not.toBe(hiddenSectionOpenKey('b'));
  });

  it('the component starts closed (useState(false)) and links its rows to real pages', () => {
    const src = readFileSync(fileURLToPath(new URL('../components/sidebar.tsx', import.meta.url)), 'utf8');
    const section = src.slice(src.indexOf('function HiddenSection('), src.indexOf('function HiddenRow('));
    expect(section).toMatch(/const \[open, setOpen\] = useState\(false\)/);
    expect(section).toMatch(/href=\{`\/w\/\$\{ws\}\/s\/\$\{s\.id\}`\}/);
  });
});

describe('placeHref: a search result for a place opens that place, never home', () => {
  it('a space opens its own page', () => {
    expect(placeHref('w1', { kind: 'space', id: 'agentic-os' })).toBe('/w/w1/s/agentic-os');
  });

  it('a database (a system one, in a hidden space, included) opens its own page', () => {
    expect(placeHref('w1', { kind: 'database', id: 'agents' })).toBe('/w/w1/d/agents');
  });

  it('no place ever routes to the workspace home', () => {
    for (const kind of ['space', 'database'] as const) {
      expect(placeHref('w1', { kind, id: 'x' })).not.toBe('/w/w1');
    }
  });

  it('the palette routes places through it', () => {
    const src = readFileSync(fileURLToPath(new URL('../components/command-palette.tsx', import.meta.url)), 'utf8');
    expect(src).toMatch(/run: \(\) => go\(placeHref\(ws, place\)\)/);
    expect(src).not.toMatch(/: go\(`\/w\/\$\{ws\}`\)\)/);
  });
});
