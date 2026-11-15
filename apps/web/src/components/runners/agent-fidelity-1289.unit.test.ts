import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentAvatar } from '@/components/tyron/agent-avatar';

/**
 * Ticket #1289 items 2, 5, 6 and 8 (Otto's rulings of 2026-11-13). The avatar is rendered; the pages and the sidebar section are
 * hook-heavy, so their rules are pinned against the source with assertions that name what each one protects.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const page = read('./agent-page.tsx');
const list = read('../../app/w/[ws]/agents/page.tsx');
const hire = read('./hire-dialog.tsx');
const sidebar = read('../sidebar-ai-section.tsx');

describe('one agent mark: a gold-tint circle (item 5)', () => {
  const html = (props: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(AgentAvatar, { name: 'Onboarding Assistant', ...props }));
  it('the circle shape is round, tinted gold and carries the bot glyph in the darker, readable gold step', () => {
    const h = html({ shape: 'circle', size: 'lg' });
    expect(h).toContain('rounded-full');
    expect(h).not.toContain('rounded-md');
    expect(h).toContain('bg-accent-soft');
    expect(h).toContain('text-accent-text');
    expect(h).toContain('lucide-bot');
  });
  it('KEEPS the squircle with Sparkles everywhere that did not opt in (mentions, approvals, chat sit beside people)', () => {
    const h = html();
    expect(h).toContain('rounded-md');
    expect(h).not.toContain('rounded-full');
    expect(h).toContain('lucide-sparkles');
    expect(h).not.toContain('lucide-bot');
  });
  it('the list (26px), the agent page (40px) and the hire card all draw the circle, so they cannot drift apart', () => {
    expect(list).toMatch(/<AgentAvatar[^>]*shape="circle"[^>]*h-\[26px\] w-\[26px\]/);
    expect(page).toMatch(/<AgentAvatar[^>]*size="lg" shape="circle"/);
    expect(hire).toMatch(/<AgentAvatar[^>]*size="lg" shape="circle"/);
  });
});

describe('a way back, and Hire stays on the list (item 2)', () => {
  it('the agent page opens with "← Agents" linking to the list, 12px/600 in the link colour', () => {
    expect(page).toMatch(/href=\{`\/w\/\$\{ws\}\/agents`\}[^>]*text-label font-semibold text-primary-text/);
    expect(page).toContain('← Agents');
  });
  it('the agent page has no Hire button and mounts no hire dialog; the list keeps both', () => {
    expect(page).not.toContain('Hire an agent');
    expect(page).not.toContain('HireDialog');
    expect(list).toContain('Hire an agent');
    expect(list).toContain('<HireDialog');
  });
});

describe('titles and buttons (item 6)', () => {
  it('the agent name in the list row is 700, as drawn', () => {
    expect(list).toContain('<b className="block truncate font-bold">{a.name}</b>');
  });
  it('both pages draw the h1 at 20px/700', () => {
    expect(list).toMatch(/<h1[^>]*text-\[20px\] font-bold/);
    expect(page).toMatch(/<h1[^>]*text-\[20px\] font-bold/);
  });
  it('the hire card title is 14px/700, its labels 13px ink and its footer buttons the one small size', () => {
    expect(hire).toContain('titleClassName="mb-3 text-prose font-bold"');
    for (const label of ['Wakes when', 'Works in', 'Asks before']) expect(hire).toContain(`<div className="mb-1 text-body text-ink">${label}</div>`);
    expect(hire).toContain('htmlFor="hire-name" className="text-body text-ink"');
    expect(hire).toMatch(/variant="secondary" size="sm" onClick=\{onClose\}/);
    expect(hire).toMatch(/<Button type="button" size="sm" disabled=\{busy/);
  });
});

describe('Agent runs and Triggers leave the sidebar and stay reachable (item 8)', () => {
  it('the AI section no longer builds child rows or a caret for the two system databases', () => {
    expect(sidebar).not.toContain('agentChildren');
    expect(sidebar).not.toContain('Expand Agents');
    expect(sidebar).not.toContain('AGENT_SYSTEM_LABELS.runs');
  });
  it('KEEPS the Agents row, which opens the agents page and stays lit on the Agents database', () => {
    expect(sidebar).toContain('AGENT_SYSTEM_LABELS.agents');
    expect(sidebar).toContain('const agentsHref = agentsDbHref ? `/w/${ws}/agents` : null;');
    expect(sidebar).toContain('active={onAgents(agentsHref)}');
  });
  it('the agent page links both tables, by their design names, only for ones the person can see', () => {
    expect(page).toContain("(['runs', 'agent triggers'] as const)");
    expect(page).toContain('AGENT_SYSTEM_LABELS[k]');
    expect(page).toContain('if (links.length === 0) return null;');
  });
});

describe('the hire card wires whole spaces through to wake rules (item 7)', () => {
  it('Works in and the rule list both use the one `watchableDatabases` answer, so a space chip never empties the rule picker or strands a rule', () => {
    expect(hire).toContain('const workDbs = watchableDatabases(works, databases.data ?? []);');
    expect(hire).toContain('rebaseRules(rules, watchableDatabases(next, databases.data ?? []).map((w) => w.id))');
  });
  it('a space is offered only where the Agents database can hold it, and an admin\u2019s hire adds the field first', () => {
    expect(hire).toContain('wholeSpaceTargets: holdsSpaceTargets(agentFields) || canSetupAgents(role)');
    expect(hire).toContain("'/api/v1/workspaces/{ws}/agents/ensure'");
  });
});
