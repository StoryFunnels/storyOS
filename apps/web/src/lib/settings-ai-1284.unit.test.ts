import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chainOf, describeAction, triggerInWords, type AuditEventRow, type TriggerFields, type TriggerNames } from './governance';

/** Ticket #1284 — Settings > AI fidelity: Agent rules' boxed sections and the Recent agent actions rows. Source guards, each mutation-checked. */
const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
const page = read('../app/w/[ws]/settings/agent-rules/page.tsx');
const actions = read('../components/governance/agent-actions.tsx');
const chrome = read('../components/settings/settings-chrome.tsx');

describe('Agent rules sections use the shared Settings box header', () => {
  it('Section is a SettingsBox with a title, not a bare heading', () => {
    expect(page).toMatch(/<SettingsBox title=\{title\}/);
    expect(page).not.toMatch(/<h2 className="mb-1 text-body font-semibold/);
  });
  it('every section the page had is still there (nothing dropped by the restyle)', () => {
    for (const t of ['Agents', 'Gates in force', 'Approvals', 'Recent agent actions', 'Always enforced', 'What this page cannot show']) {
      expect(page).toContain(`title="${t}"`);
    }
  });
  it('the two controls the prototype opens with are kept, and still first', () => {
    expect(page.indexOf('<DefaultAgentModel')).toBeLessThan(page.indexOf('Let AI share skills with the whole workspace'));
    expect(page.indexOf('Let AI share skills with the whole workspace')).toBeLessThan(page.indexOf('<Section'));
  });
});

describe('Recent agent actions rows', () => {
  const rowBlock = actions.slice(actions.indexOf('{rows.map((r) => {'), actions.indexOf('log.hasNextPage'));
  it('the missing-credential sentence is rendered once, outside the row loop', () => {
    expect(actions.match(/missingCredentialNote\(/g)).toHaveLength(1);
    expect(actions.indexOf('missingCredentialNote(')).toBeLessThan(actions.indexOf('{rows.map((r) => {'));
    expect(rowBlock).not.toMatch(/NO_CREDENTIAL/);
  });
  it('a row leads with who acted (bold) and shows the event in words, through the shared helpers', () => {
    expect(rowBlock).toContain('actionSubject(r, credential)');
    expect(rowBlock).toContain('describeAction(r, triggerWordsOf(r.record_id))');
    expect(rowBlock).toContain('actionMeta(r, credential)');
    expect(rowBlock).toMatch(/<b className="[^"]*font-semibold[^"]*">\{actionSubject/);
  });
  it('the row mark is gold because an agent acted, and carries no text of its own', () => {
    expect(rowBlock).toContain('<Rocket');
    expect(rowBlock).toContain('aria-hidden');
    expect(rowBlock).toContain('text-accent-text');
  });
  it('the full chain dialog still names a missing credential, per action', () => {
    expect(actions).toContain('chainOf(open');
  });
});

describe('Agent rules is the prototype’s boxes, with everything else in ONE closed disclosure at the bottom (Otto 2026-11-13, item 1)', () => {
  const at = page.indexOf('<AdvancedSection');
  const boxes = page.slice(0, at);
  const advanced = page.slice(at);

  it('exactly one disclosure, and it is the last thing on the page', () => {
    expect(page.match(/<AdvancedSection/g)).toHaveLength(1);
    expect(advanced).toMatch(/<\/AdvancedSection>\s*<\/div>\s*\);\s*\}\s*$/);
    expect(advanced).toContain('title="How agent rules are enforced"');
  });
  it('it is closed by default: no `open` on it, and it is the shared native disclosure (keyboard: Tab, Enter or Space; the browser reports its expanded state)', () => {
    expect(advanced.slice(0, advanced.indexOf('>'))).not.toMatch(/\bopen\b/);
    expect(chrome).toMatch(/export function AdvancedSection[\s\S]*<details[\s\S]*<summary/);
  });
  it('the boxes are: Default model, skill sharing, Recent agent actions with "Full audit log →"', () => {
    expect(boxes).toContain('<DefaultAgentModel');
    expect(boxes).toContain('Let AI share skills with the whole workspace');
    expect(boxes).toContain('title="Recent agent actions"');
    expect(boxes).toContain('Full audit log →');
    expect(boxes).toContain('/settings/audit-log');
  });
  it('NOTHING was removed or made unreachable: every control and section the page had is in a box or inside Advanced', () => {
    // The page's inventory before this change, each with where it lives now.
    const before: Array<[string, 'box' | 'advanced']> = [
      ['<DefaultAgentModel', 'box'],
      ['aria-label="Let AI share skills with the whole workspace"', 'box'],
      ['<Switch', 'box'],
      ['<AgentActions ws={ws} />', 'box'],
      ['title="Agents"', 'advanced'],
      ['title="Gates in force"', 'advanced'],
      ['title="Approvals"', 'advanced'],
      ['title="Always enforced"', 'advanced'],
      ['title="What this page cannot show"', 'advanced'],
      ['ENFORCED_RULES.map', 'advanced'],
      ['NOT_COVERED.map', 'advanced'],
      ['ungovernedWorkspace(agents, inForce) &&', 'advanced'],
      ['Some of this could not be loaded', 'advanced'],
      ['Approver: {nameOf(g.approverId)}', 'advanced'],
      ['Nobody has decided an approval yet.', 'advanced'],
    ];
    for (const [needle, where] of before) {
      const home = where === 'box' ? boxes : advanced;
      const other = where === 'box' ? advanced : boxes;
      expect(home, needle).toContain(needle);
      expect(other, `${needle} should be in exactly one place`).not.toContain(needle);
    }
  });
  it('the safety facts do not hide: a workspace with no gate in force says so on the closed disclosure', () => {
    expect(page).toContain("'no approval gate is in force'");
    expect(page).toContain("'some of this could not be loaded'");
  });
});

describe('a wake rule is shown in words, never by its stored title or ids (Otto 2026-11-13, item 2)', () => {
  const dbs: Record<string, string> = { db1: 'Clients', db2: 'Task' };
  const fieldsByDb: Record<string, Record<string, { name: string; options?: Record<string, string> }>> = {
    db1: { f1: { name: 'Status', options: { o1: 'Onboarding' } } },
    db2: { f2: { name: 'Owner' } },
  };
  const names: TriggerNames = {
    agent: () => null,
    database: (id) => dbs[id] ?? null,
    field: (d, f) => {
      const x = fieldsByDb[d]?.[f];
      return x ? { name: x.name, option: (o) => x.options?.[o] ?? null } : null;
    },
  };
  const state: TriggerFields = {
    agent: [{ id: 'a1', title: 'Onboarding Assistant' }],
    database: 'db1',
    state_field: 'f1',
    state_option: 'o1',
  };
  const STORED = 'Onboarding Assistant ← Clients.Status = Onboarding';
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

  it('a state rule reads as the ruling’s sentence', () => {
    expect(triggerInWords(state, names)).toBe("a wake rule for Onboarding Assistant: Clients' Status becomes Onboarding");
  });
  it('a relation rule reads in words too', () => {
    expect(triggerInWords({ agent: [{ id: 'a1', title: 'Triage' }], database: 'db2', relation_field: 'f2' }, names)).toBe(
      "a wake rule for Triage: a record is linked in Task's Owner",
    );
  });
  it('every part that cannot be resolved is left out: neutral text, never an id and never the trigger syntax', () => {
    const none: TriggerNames = { agent: () => null, database: () => null, field: () => null };
    const cases: string[] = [
      triggerInWords({ database: 'db-gone', state_field: 'f-gone', state_option: 'o-gone' }, none),
      triggerInWords({ agent: ['5a706281-cda4-494b-b954-ad81fe37d79a'], database: 'db1', state_field: 'f1', state_option: 'o1' }, none),
      triggerInWords({}, names),
      triggerInWords({ ...state, state_option: 'o-deleted' }, names),
      triggerInWords({ ...state, database: 'db-deleted' }, names),
    ];
    expect(cases[0]).toBe('a wake rule');
    expect(cases[2]).toBe('a wake rule');
    expect(cases[3]).toBe("a wake rule for Onboarding Assistant: Clients' Status changes");
    for (const c of cases) {
      expect(c).not.toMatch(uuid);
      expect(c).not.toContain('←');
      expect(c).not.toContain(' = ');
    }
  });
  it('a row about a rule says it in words; the stored title only decides that it IS a rule when the fields are unreadable', () => {
    const words = triggerInWords(state, names);
    expect(describeAction({ type: 'record.created', payload: { title: STORED } }, words)).toBe(`Created ${words}`);
    expect(describeAction({ type: 'record.created', payload: { title: STORED } })).toBe('Created a wake rule');
    expect(describeAction({ type: 'record.deleted', payload: { title: STORED } })).toBe('Deleted a wake rule');
    expect(describeAction({ type: 'record.updated', payload: { title: STORED } }, words)).not.toContain('←');
  });
  it('KEEPS an ordinary record title, even one with an arrow in it: only the exact stored rule shape is translated', () => {
    expect(describeAction({ type: 'record.updated', payload: { title: 'Fix the header' } })).toBe('Updated “Fix the header”');
    expect(describeAction({ type: 'record.updated', payload: { title: 'Plan ← Review notes' } })).toBe('Updated “Plan ← Review notes”');
    expect(describeAction({ type: 'record.updated', payload: { title: 'Plan ← v2.0 shipped' } })).toBe('Updated “Plan ← v2.0 shipped”');
  });
  it('the full-chain Action line uses the same words', () => {
    const row: AuditEventRow = {
      kind: 'event',
      id: 'e1',
      record_id: 'r1',
      type: 'record.created',
      actor_id: 'u1',
      actor_name: 'Ada',
      source: 'agent',
      payload: { title: STORED },
      created_at: '2026-11-11T00:00:00Z',
    };
    const steps = chainOf(row, null, { space: () => null, database: () => null }, () => 'then', triggerInWords(state, names));
    expect(steps.find((s) => s.label === 'Action')?.value).toContain("Clients' Status becomes Onboarding");
    expect(steps.find((s) => s.label === 'Action')?.value).not.toContain('←');
  });
  it('DISPLAY ONLY: the formatter does not touch the stored record, and the list never writes to a record', () => {
    const stored = Object.freeze({ title: STORED, values: Object.freeze({ ...state }) });
    const snapshot = JSON.stringify(stored);
    triggerInWords(stored.values, names);
    describeAction({ type: 'record.created', payload: { title: stored.title } }, triggerInWords(stored.values, names));
    expect(JSON.stringify(stored)).toBe(snapshot);
    expect(actions).not.toMatch(/api\.(PATCH|PUT|POST|DELETE)/);
    expect(actions).not.toContain('useMutation');
  });
});
