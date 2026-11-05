import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiConnectionsList, connectionLine } from '@/components/settings/ai-connections-list';
import { connectBody, disconnectVariant } from './ai-connections';
import type { AiConnection } from './ai-connections';

/** Dara's review of PR #1411 (ticket #1187): the card under the list, the last-use line, and the row actions. */
const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');
const base: AiConnection = { id: 'oauth:a', kind: 'oauth', client_name: 'Claude', connected_at: '2026-10-20T09:00:00Z', last_used_at: null, reaches: 'all_workspaces', approved: null };
const broken: AiConnection = { ...base, id: 'oauth:b', client_name: 'Cursor', reaches: 'needs_reconnect' };
const token: AiConnection = { ...base, id: 'token:1', kind: 'token', client_name: 'Key', reaches: 'this_workspace' };
const odd: AiConnection = { ...base, id: 'oauth:c', client_name: 'Odd', reaches: 'something_new' as never };
const date = (v: unknown) => `<${String(v).slice(0, 10)}>`;
const html = (items: AiConnection[]) =>
  renderToStaticMarkup(createElement(AiConnectionsList, { view: { kind: 'ready', items, busyId: null }, date, onDisconnect: () => {}, onReconnect: () => {} }));

describe('the body under the AI apps list', () => {
  it('"Your AI is connected" is hidden whenever the list has at least one app; shown only for an empty list of a connected AI', () => {
    expect(connectBody({ appCount: 1, aiConnected: true, adding: false })).toBe('list-only');
    expect(connectBody({ appCount: 7, aiConnected: true, adding: false })).toBe('list-only');
    expect(connectBody({ appCount: 3, aiConnected: false, adding: false })).toBe('list-only');
    expect(connectBody({ appCount: 0, aiConnected: true, adding: false })).toBe('card');
    expect(connectBody({ appCount: 0, aiConnected: false, adding: false })).toBe('steps');
  });
  it('nothing is claimed before the list has loaded, and "Connect an AI" opens the steps even with apps listed', () => {
    expect(connectBody({ appCount: undefined, aiConnected: true, adding: false })).toBe('pending');
    expect(connectBody({ appCount: 4, aiConnected: true, adding: true })).toBe('steps');
  });
  it('the page uses the predicate and renders the card only for `card`', () => {
    const page = read('../app/w/[ws]/settings/connect-ai/page.tsx');
    expect(page).toContain('connectBody(');
    expect(page).toMatch(/\{body === 'card' \? \(\s*<ConnectedCard/);
    expect(page).not.toContain('showConnected');
  });
});

describe('last use only when it has a date', () => {
  it('no "not recorded", "never used" or last-use text on any kind of row without a date', () => {
    for (const c of [base, broken, token, odd]) expect(connectionLine(c, date)).not.toMatch(/not recorded|never used|last use/i);
  });
  it('a dated last use is still shown', () => {
    expect(connectionLine({ ...token, last_used_at: '2026-10-20T10:00:00Z' }, date)).toContain('last used <2026-10-20>');
  });
});

describe('row actions at natural width', () => {
  it('on a broken row Reconnect is the one bordered button and Disconnect is ghost; on a healthy row Disconnect keeps its border', () => {
    expect(disconnectVariant(broken)).toBe('ghost');
    expect(disconnectVariant(base)).toBe('secondary');
    expect(disconnectVariant(token)).toBe('secondary');
    const buttons = html([broken]).match(/<button[^>]*>/g) ?? [];
    const reconnect = buttons.find((b) => b.includes('aria-label="Reconnect Cursor"'))!;
    const disconnect = buttons.find((b) => b.includes('aria-label="Disconnect Cursor"'))!;
    expect(reconnect).toContain('border-border-default');
    expect(disconnect).not.toContain('border');
    expect((html([base]).match(/<button[^>]*>/g) ?? [])[0]).toContain('border-border-default');
  });
  it("the buttons sit in their own wrapper, so the row's phone rule that stretches its DIRECT buttons never reaches them", () => {
    expect(html([broken])).toMatch(/<div class="flex items-center gap-2"><button[^>]*aria-label="Reconnect Cursor"/);
    // the shared chrome is untouched (it is byte-identical to PR #1410's): the fix is in how the list uses it
    expect(read('../components/settings/settings-chrome.tsx')).toContain('max-sm:[&>button:not([role=switch])]:flex-1');
  });
});
