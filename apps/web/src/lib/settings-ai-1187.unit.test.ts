import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiConnectionsList } from '@/components/settings/ai-connections-list';
import { aiAppsSummary, canReconnect, connectionState, NEEDS_RECONNECT_REASON } from './ai-connections';
import type { AiConnection } from './ai-connections';
import { buildActivationSteps } from './activation';
import { SETTINGS_PAGES, canOpenSettingsPage } from './settings-nav';
import { skillSharingOn } from './skill-sharing';

/** Ticket #1187 — Settings 3, AI: reconnect states, Agent rules (was Governance) and the skill-sharing toggle. */
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const base: AiConnection = { id: 'oauth:a', kind: 'oauth', client_name: 'Claude', connected_at: '2026-10-20T09:00:00Z', last_used_at: null, reaches: 'all_workspaces', approved: null };
const broken: AiConnection = { ...base, id: 'oauth:b', client_name: 'Cursor', reaches: 'needs_reconnect' };
const token: AiConnection = { ...base, id: 'token:1', kind: 'token', client_name: 'Key', reaches: 'this_workspace' };
const odd: AiConnection = { ...base, id: 'oauth:c', client_name: 'Odd', reaches: 'something_new' as never };
const date = (v: unknown) => `<${String(v).slice(0, 10)}>`;
const html = (items: AiConnection[], extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(AiConnectionsList, { view: { kind: 'ready', items, busyId: null }, date, onDisconnect: () => {}, onReconnect: () => {}, ...extra }),
  );

describe('connection state model: the reason comes from the data (AC1)', () => {
  it('connected, needs a reconnect with the documented reason, or unknown', () => {
    expect(connectionState({ reaches: 'all_workspaces' })).toEqual({ kind: 'connected' });
    expect(connectionState({ reaches: 'one_workspace' })).toEqual({ kind: 'connected' });
    expect(connectionState({ reaches: 'this_workspace' })).toEqual({ kind: 'connected' });
    expect(connectionState({ reaches: 'needs_reconnect' })).toEqual({ kind: 'needs_reconnect', reason: NEEDS_RECONNECT_REASON });
    expect(connectionState({ reaches: 'something_new' as never })).toEqual({ kind: 'unknown' });
  });
  it('the reason names no cause the API cannot tell: never "expired" or "revoked"', () => {
    expect(NEEDS_RECONNECT_REASON).not.toMatch(/expired|revoked/i);
  });
  it('Reconnect is available only for needs-reconnect', () => {
    expect(canReconnect(base)).toBe(false);
    expect(canReconnect(token)).toBe(false);
    expect(canReconnect(odd)).toBe(false);
    expect(canReconnect(broken)).toBe(true);
  });
  it('the box summary counts the ones that need reconnecting and omits the count when none do', () => {
    expect(aiAppsSummary([base, broken, broken, token])).toBe('4 · 2 need reconnecting');
    expect(aiAppsSummary([base, token])).toBe('2');
  });
});

describe('the AI apps list', () => {
  it('shows Reconnect and a Not working pill ONLY on the app that needs one; every row keeps Disconnect', () => {
    const out = html([base, broken, token, odd]);
    expect(out.match(/aria-label="Reconnect /g)).toHaveLength(1);
    expect(out).toContain('aria-label="Reconnect Cursor"');
    expect(out.match(/Not working/g)).toHaveLength(1);
    expect(out).toContain('Can’t reach StoryOS until it is reconnected');
    expect(out.match(/>Disconnect</g)).toHaveLength(4);
    expect(out).toContain('4 · 1 need reconnecting');
  });
  it('without an onReconnect handler no Reconnect button is drawn', () => {
    expect(html([broken], { onReconnect: undefined })).not.toContain('Reconnect Cursor');
  });
  it('the Reconnect panel opens under its own row only', () => {
    const panel = () => createElement('div', { 'data-testid': 'panel' }, 'steps');
    expect(html([base, broken], { reconnectingId: broken.id, panel })).toContain('data-testid="panel"');
    expect(html([base, broken], { reconnectingId: null, panel })).not.toContain('data-testid="panel"');
    // a healthy row can never open one, even if its id is the open one
    expect(html([base, broken], { reconnectingId: base.id, panel })).not.toContain('data-testid="panel"');
  });
});

describe('the checklist link (AC2)', () => {
  it('"Connect your AI" goes to /settings/connect-ai, not /settings/api', () => {
    const steps = buildActivationSteps(
      { database_created: true, records_added: true, teammate_invited: true, board_view_built: true, relation_created: true, ai_connected: false, business_pack_installed: true },
      { ws: 'w1' },
    );
    expect(steps.find((s) => s.key === 'ai_connected')?.href).toBe('/w/w1/settings/connect-ai');
  });
});

/** Every control the Governance page had, listed from the old page (origin/main before this ticket). A dropped one fails. */
const FORMER_GOVERNANCE_CONTROLS = [
  '<AgentActions',
  'title="Agents"',
  'title="Gates in force"',
  'title="Approvals"',
  'title="Recent agent actions"',
  'title="Always enforced"',
  'title="What this page cannot show"',
  'ENFORCED_RULES',
  'NOT_COVERED',
  'ungovernedWorkspace',
  'describeAgent',
  'describeGate',
  'summariseApprovals',
  'SCOPE_WORDS',
  'WHERE_WORDS',
  'Approver:',
  'Nobody has decided an approval yet.',
];

describe('Agent rules replaces Governance (AC3)', () => {
  const page = read('../app/w/[ws]/settings/agent-rules/page.tsx');
  it('carries every former Governance control', () => {
    const missing = FORMER_GOVERNANCE_CONTROLS.filter((c) => !page.includes(c));
    expect(missing).toEqual([]);
  });
  it('the old route is only a redirect now, with no page of its own', () => {
    const old = read('../app/w/[ws]/settings/governance/page.tsx');
    expect(old).toContain('redirect(');
    expect(old).not.toContain('AgentActions');
  });
});

describe('the skill-sharing toggle moved from General to Agent rules (AC4)', () => {
  it('is in Agent rules, through the shared hook and the shared Switch', () => {
    const page = read('../app/w/[ws]/settings/agent-rules/page.tsx');
    expect(page).toContain('useSkillSharing');
    expect(page).toContain('<Switch');
    expect(page).toContain('Let AI share skills with the whole workspace');
  });
  it('is gone from General: no label, no setting key, no switch', () => {
    const general = read('../app/w/[ws]/settings/general/page.tsx');
    expect(general).not.toContain('Let AI share skills');
    expect(general).not.toContain('agents_may_publish_skills');
    expect(general).not.toContain('<Switch');
  });
  it('the setting is the same one, written once: only an explicit false turns it off', () => {
    expect(skillSharingOn(undefined)).toBe(true);
    expect(skillSharingOn({})).toBe(true);
    expect(skillSharingOn({ agents_may_publish_skills: true })).toBe(true);
    expect(skillSharingOn({ agents_may_publish_skills: false })).toBe(false);
    expect(read('./skill-sharing.ts')).toContain('agents_may_publish_skills: next');
  });
});

describe('Agent rules is for admins: member and guest are refused in the page by URL', () => {
  const page = SETTINGS_PAGES.find((p) => p.id === 'agent-rules')!;
  it('admin opens it; member and guest do not', () => {
    expect(canOpenSettingsPage(page, 'admin')).toBe(true);
    expect(canOpenSettingsPage(page, 'member')).toBe(false);
    expect(canOpenSettingsPage(page, 'guest')).toBe(false);
  });
  it('its layout wraps the shared admins-only refusal', () => {
    expect(read('../app/w/[ws]/settings/agent-rules/layout.tsx')).toContain('<AdminsOnly title="Agent rules">');
  });
});
