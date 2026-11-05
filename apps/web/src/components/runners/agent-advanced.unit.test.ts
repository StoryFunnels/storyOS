import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { canSeeRunnerDetails } from '@/lib/runners/access';
import { AgentAdvanced } from './agent-advanced';

/** Ticket #1180 (web) — what a person SEES in Advanced, as markup, for a manager, a non-manager and the saved states. */
const base = {
  savedTools: null as string | null,
  savedModel: null as string | null,
  workspaceDefaultModel: 'sonnet' as string | null,
  canEdit: true,
  ownerName: 'Ievgen Krasovytskyi' as string | null,
  brand: 'Claude',
  chosenTool: 'claude-code' as string | null,
  saving: false,
  onSave: async () => undefined,
};
const html = (over: Partial<typeof base> = {}) => renderToStaticMarkup(createElement(AgentAdvanced, { ...base, ...over }));
const tag = (h: string, name: string) => h.match(new RegExp(`<input[^>]*data-testid="tool-${name}"[^>]*>`))?.[0] ?? '';

describe('Advanced · tools and model, for a manager', () => {
  it('is a closed section titled "Advanced · tools and model"', () => {
    const h = html();
    expect(h).toContain('<details');
    expect(h).not.toMatch(/<details[^>]*\bopen\b/);
    expect(h).toContain('Advanced');
    expect(h).toContain('· tools and model');
  });
  it('shows the 8 essentials ticked and fixed ("always on"), so they cannot be removed', () => {
    const h = html();
    for (const n of ['get_record', 'list_comments', 'query_records', 'count_records', 'describe_database', 'update_record', 'add_comment', 'create_record']) {
      const t = tag(h, n);
      expect(t, n).toContain('checked');
      expect(t, n).toContain('disabled');
    }
    expect(h).toContain('Change a record (any of its fields)');
    expect(h).toContain('always on');
  });
  it('lists the extras UNTICKED and enabled, each with its one-line why; delete_record is not among them', () => {
    const h = html();
    const t = tag(h, 'link_records');
    expect(t).not.toContain('checked');
    expect(t).not.toContain('disabled');
    expect(h).toContain('Connect a record to others, e.g. a task to its client');
    expect(h).not.toContain('data-testid="tool-delete_record"');
  });
  it('a saved extra is ticked', () => {
    const h = html({ savedTools: 'link_records' });
    expect(tag(h, 'link_records')).toContain('checked');
    expect(tag(h, 'search')).not.toContain('checked');
  });
  it('says the cost, and that it is not a permission', () => {
    expect(html()).toContain('Each tool you add makes every run a little bigger on your Claude limit, so add only what its job needs. It can never do more than its role allows.');
  });
  it('an unknown saved name is shown with a Remove, never hidden', () => {
    const h = html({ savedTools: 'link_records,retired_tool' });
    expect(h).toContain('retired_tool');
    expect(h).toContain('no longer exists');
    expect(h).toContain('Remove retired_tool');
  });
  it('the opt-in `all` is named in words, with the way back, and the extras list steps aside', () => {
    const h = html({ savedTools: 'all' });
    expect(h).toContain('every tool its role allows');
    expect(h).toContain('Go back to the essentials');
    expect(h).not.toContain('data-testid="agent-extras"');
  });
  it('the model note follows the workspace by default and has no reset link', () => {
    const h = html();
    expect(h).toContain('Uses the workspace default (Sonnet). Change it for this agent only.');
    expect(h).not.toContain('Reset to the workspace default');
    expect(h).toContain('Workspace default (Sonnet)');
  });
  it('a chosen model says only this agent uses it and offers the reset link', () => {
    const h = html({ savedModel: 'haiku' });
    expect(h).toContain('Only this agent uses Haiku.');
    expect(h).toContain('Reset to the workspace default');
  });
  it('with Cursor assigned the model control is disabled and says why', () => {
    const h = html({ chosenTool: 'cursor' });
    expect(h).toContain('Cursor picks the model from your Cursor plan.');
    expect(h).toMatch(/<button[^>]*aria-label="Model"[^>]*disabled/);
  });
  it('shows no read-only line to someone who can change it', () => {
    expect(html()).not.toContain('who manages this agent');
  });
});

describe('the same section for someone who cannot change it', () => {
  const ro = (over: Partial<typeof base> = {}) => html({ canEdit: false, ...over });
  it('every extra is disabled, there is no Remove and no reset, and the line says who manages the agent', () => {
    const h = ro({ savedTools: 'link_records,retired_tool', savedModel: 'haiku' });
    expect(tag(h, 'link_records')).toContain('disabled');
    expect(tag(h, 'search')).toContain('disabled');
    expect(h).not.toContain('Remove retired_tool');
    expect(h).not.toContain('Reset to the workspace default');
    expect(h).toMatch(/<button[^>]*aria-label="Model"[^>]*disabled/);
    expect(h).toContain('Only Ievgen Krasovytskyi, who manages this agent, can change these.');
  });
  it('still shows what is saved, so reading it is not blocked', () => {
    const h = ro({ savedTools: 'link_records', savedModel: 'opus' });
    expect(tag(h, 'link_records')).toContain('checked');
    expect(h).toContain('Only this agent uses Opus.');
  });
  it('without a known owner it says "its owner"', () => {
    expect(ro({ ownerName: null })).toContain('Only its owner, who manages this agent, can change these.');
  });
  it('a guest is never shown the section (the page uses the same gate as the machine name): the gate refuses a guest and an unloaded role', () => {
    expect(canSeeRunnerDetails('guest')).toBe(false);
    expect(canSeeRunnerDetails(undefined)).toBe(false);
    expect(canSeeRunnerDetails('member')).toBe(true);
    const page = readFileSync(fileURLToPath(new URL('./agent-page.tsx', import.meta.url)), 'utf8');
    expect(page).toMatch(/usesRunner && !masked && \(\s*<AgentAdvanced/);
  });
});

describe('the house rules for this surface, checked in the source', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const files = ['./agent-advanced.tsx', '../governance/default-agent-model.tsx', '../../lib/runners/agent-settings.ts'];
  it('no native <select>: both model menus are the product’s own MenuSelect', () => {
    for (const f of files) expect(read(f), f).not.toMatch(/<select\b/);
    expect(read('./agent-advanced.tsx')).toContain('MenuSelect');
    expect(read('../governance/default-agent-model.tsx')).toContain('MenuSelect');
  });
  it('no gold: settings are not an agent acting (ticket #1163), and no undeclared var() fallback', () => {
    for (const f of files) {
      expect(read(f), f).not.toMatch(/gold|accent-gold|var\(--[a-z-]+,/i);
    }
  });
  it('the Agent rules page (was governance, ticket #1187) mounts the workspace default', () => {
    const page = read('../../app/w/[ws]/settings/agent-rules/page.tsx');
    expect(page).toContain('<DefaultAgentModel ws={ws} />');
  });
});
