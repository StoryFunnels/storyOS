import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
    expect(rowBlock).toContain('describeAction(r)');
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
