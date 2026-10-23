import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AiConnectionsList } from './ai-connections-list';
import type { AiConnectionsView } from './ai-connections-list';
import type { AiConnection } from '@/lib/ai-connections';

const oauth: AiConnection = {
  id: 'oauth:abc',
  kind: 'oauth',
  client_name: 'Claude',
  connected_at: '2026-10-01T09:00:00Z',
  last_used_at: null,
  reaches: 'all_your_workspaces',
};
const token: AiConnection = {
  id: 'token:1f0c0f6e-0000-4000-8000-000000000001',
  kind: 'token',
  client_name: 'Cursor key',
  connected_at: '2026-10-05T09:00:00Z',
  last_used_at: '2026-10-20T10:00:00Z',
  reaches: 'this_workspace',
};
const html = (view: AiConnectionsView) =>
  renderToStaticMarkup(createElement(AiConnectionsList, { view, date: (v: unknown) => `<${String(v).slice(0, 10)}>`, onDisconnect: () => {} }));

describe('the connected AI clients list (#1030)', () => {
  it('shows each client with how it connected, what it reaches, since when and last used, and a Disconnect for each', () => {
    const out = html({ kind: 'ready', items: [oauth, token], busyId: null });
    expect(out).toContain('Claude');
    expect(out).toContain('Connected by signing in · All your workspaces');
    expect(out).toContain('Connected &lt;2026-10-01&gt;');
    expect(out).toContain('Last use not recorded');
    expect(out).toContain('Cursor key');
    expect(out).toContain('Personal access token · This workspace only');
    expect(out).toContain('Last used &lt;2026-10-20&gt;');
    expect(out.match(/>Disconnect</g)).toHaveLength(2);
    expect(out).toContain('aria-label="Disconnect Claude"');
  });

  it('a row being disconnected says so, and every button is disabled meanwhile', () => {
    const out = html({ kind: 'ready', items: [oauth, token], busyId: oauth.id });
    expect(out).toContain('Disconnecting…');
    expect(out.match(/disabled=""/g)).toHaveLength(2);
  });

  it('says plainly when nothing is connected, and when the list could not be read', () => {
    expect(html({ kind: 'ready', items: [], busyId: null })).toContain('No AI client is connected');
    const err = html({ kind: 'error' });
    expect(err).toContain('role="alert"');
    expect(err).not.toContain('No AI client is connected');
    expect(html({ kind: 'loading' })).toContain('role="status"');
  });

  it('a client name that looks like markup is escaped', () => {
    const out = html({ kind: 'ready', items: [{ ...oauth, client_name: '<img src=x onerror=alert(1)>' }], busyId: null });
    expect(out).not.toContain('<img src=x');
    expect(out).toContain('&lt;img');
  });

  it('a connection with no recorded date does not invent one', () => {
    expect(html({ kind: 'ready', items: [{ ...oauth, connected_at: null }], busyId: null })).toContain('Connection date not recorded');
  });
});
