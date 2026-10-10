import { describe, expect, it } from 'vitest';
import { canConnectAi, settingsFlags, workspaceSettingsLinks } from './settings-nav';

const base = '/w/ws/settings';
const labels = (role: string, billing = false) => workspaceSettingsLinks(base, settingsFlags(role, billing)).map((l) => l.label);

describe('workspace settings nav by role (ticket #875)', () => {
  it('a MEMBER sees Connect your AI and API tokens, and NOT Integrations', () => {
    const l = labels('member');
    expect(l).toContain('Connect your AI');
    expect(l).toContain('API tokens');
    expect(l).not.toContain('Integrations');
  });
  it('an ADMIN keeps everything, Integrations included (the door is added, nothing moves)', () => {
    expect(labels('admin', true)).toEqual([
      'General', 'Members', 'Billing', 'Integrations', 'Connect your AI', 'API tokens', 'Export', 'Trash', 'Audit log',
    ]);
  });
  it('a GUEST sees neither Connect your AI nor API tokens nor Integrations (matches the credential they cannot mint)', () => {
    const l = labels('guest');
    expect(l).toEqual(['General']);
  });
  it('Integrations stays admin-only: no non-admin role ever gets it', () => {
    for (const role of ['member', 'guest', 'editor', 'viewer', undefined as never]) expect(labels(role)).not.toContain('Integrations');
  });
  it('Connect your AI is gated exactly like API tokens, for every role', () => {
    for (const role of ['admin', 'member', 'guest', 'editor', 'viewer']) {
      expect(labels(role).includes('Connect your AI'), role).toBe(labels(role).includes('API tokens'));
    }
  });
  it('the screen itself refuses a guest who types the URL, and nobody else', () => {
    expect(canConnectAi('guest')).toBe(false);
    for (const role of ['admin', 'member']) expect(canConnectAi(role)).toBe(true);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

describe('where Connect your AI lives and is linked from (ticket #875)', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  it('the integrations index links to the new route, not the old one', () => {
    const index = read('../app/w/[ws]/settings/integrations/page.tsx');
    expect(index).toContain('/settings/connect-ai');
    expect(index).not.toContain('/settings/integrations/mcp');
  });
  it('the old path redirects to the new route instead of 404ing', () => {
    const old = read('../app/w/[ws]/settings/integrations/mcp/page.tsx');
    expect(old).toMatch(/redirect\(`\/w\/\$\{ws\}\/settings\/connect-ai`\)/);
  });
  it('the new page refuses a guest through the shared rule, not an inline role check', () => {
    const page = read('../app/w/[ws]/settings/connect-ai/page.tsx');
    expect(page).toContain("canConnectAi(workspace.data.role)");
    expect(page).not.toMatch(/role === 'admin'/);
  });
  it('the layout builds the workspace links through the tested function', () => {
    expect(read('../app/w/[ws]/settings/layout.tsx')).toContain('workspaceSettingsLinks(base');
  });
});
