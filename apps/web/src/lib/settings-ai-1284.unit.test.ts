import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Ticket #1284 — Settings > AI fidelity: Agent rules' boxed sections and the Recent agent actions rows. Source guards, each mutation-checked. */
const read = (rel: string) => readFileSync(join(__dirname, rel), 'utf8');
const page = read('../app/w/[ws]/settings/agent-rules/page.tsx');
const actions = read('../components/governance/agent-actions.tsx');

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
