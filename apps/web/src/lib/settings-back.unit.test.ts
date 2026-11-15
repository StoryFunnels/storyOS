import { beforeEach, describe, expect, it } from 'vitest';
import { isRememberablePath, readRememberedPath, rememberOutsideSettings, settingsBackHref, workspaceHomeHref } from './settings-back';
import { showQuickAddFab } from './quick-add-visibility';

function fakeStorage(throws = false) {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => {
      if (throws) throw new Error('blocked');
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error('blocked');
      m.set(k, v);
    },
  };
}
const install = (s: ReturnType<typeof fakeStorage>) => {
  (globalThis as { window?: unknown }).window = { sessionStorage: s };
};

describe('where "Back to <workspace>" goes (ticket #1216)', () => {
  beforeEach(() => install(fakeStorage()));

  it('is the last page visited outside Settings, query string included', () => {
    rememberOutsideSettings('ws', '/w/ws/d/db1?view=v2');
    expect(settingsBackHref('ws', readRememberedPath('ws'))).toBe('/w/ws/d/db1?view=v2');
  });

  it('follows the person: a record, then home, then a space page', () => {
    for (const p of ['/w/ws/d/db1/r/rec9', '/w/ws', '/w/ws/s/space1']) rememberOutsideSettings('ws', p);
    expect(settingsBackHref('ws', readRememberedPath('ws'))).toBe('/w/ws/s/space1');
  });

  it('never remembers a settings page, so moving between settings pages keeps the page they came from', () => {
    rememberOutsideSettings('ws', '/w/ws/d/db1');
    for (const p of ['/w/ws/settings', '/w/ws/settings/members', '/w/ws/settings/integrations/github?x=1']) {
      expect(rememberOutsideSettings('ws', p), p).toBe(false);
    }
    expect(settingsBackHref('ws', readRememberedPath('ws'))).toBe('/w/ws/d/db1');
  });

  it('a deep link straight into Settings has nothing remembered, so Back is the workspace home', () => {
    expect(readRememberedPath('ws')).toBeNull();
    expect(settingsBackHref('ws', readRememberedPath('ws'))).toBe(workspaceHomeHref('ws'));
    expect(workspaceHomeHref('ws')).toBe('/w/ws');
  });

  it('never loops into Settings, even if a settings path was somehow stored', () => {
    expect(settingsBackHref('ws', '/w/ws/settings/members')).toBe('/w/ws');
    expect(settingsBackHref('ws', '/w/ws/settings')).toBe('/w/ws');
  });

  it("ignores another workspace's page and anything outside /w/{ws}", () => {
    expect(settingsBackHref('ws', '/w/other/d/db1')).toBe('/w/ws');
    expect(settingsBackHref('ws', '/login')).toBe('/w/ws');
    expect(settingsBackHref('ws', '/w/wsx/d/1')).toBe('/w/ws');
    expect(isRememberablePath('ws', '/w/ws')).toBe(true);
    expect(isRememberablePath('ws', null)).toBe(false);
  });

  it('is kept per workspace', () => {
    rememberOutsideSettings('a', '/w/a/d/1');
    rememberOutsideSettings('b', '/w/b/d/2');
    expect(readRememberedPath('a')).toBe('/w/a/d/1');
    expect(readRememberedPath('b')).toBe('/w/b/d/2');
  });

  it('survives storage being blocked: falls back to home, never throws', () => {
    install(fakeStorage(true));
    expect(rememberOutsideSettings('ws', '/w/ws/d/1')).toBe(false);
    expect(readRememberedPath('ws')).toBeNull();
    expect(settingsBackHref('ws', readRememberedPath('ws'))).toBe('/w/ws');
  });
});

describe('the floating "+" (ticket #1216)', () => {
  it('is hidden on Settings pages only', () => {
    for (const p of ['/w/ws/settings', '/w/ws/settings/members', '/w/ws/settings/integrations/github']) expect(showQuickAddFab(p), p).toBe(false);
  });

  it('is hidden on a database page while the toolbar has its own New (ticket #1275 item 10)', () => {
    for (const p of ['/w/ws/d/db1', '/w/ws/d/db1/']) expect(showQuickAddFab(p), p).toBe(false);
    for (const p of ['/w/ws/d/db1', '/w/ws/d/db1/']) expect(showQuickAddFab(p, false), p).toBe(false);
  });

  it('is SHOWN on a database page whose toolbar has no New: a dashboard view, a read-only viewer (Otto 2026-11-13)', () => {
    for (const p of ['/w/ws/d/db1', '/w/ws/d/db1/']) expect(showQuickAddFab(p, true), p).toBe(true);
  });

  it('never returns to Settings, whatever the toolbar says', () => {
    expect(showQuickAddFab('/w/ws/settings', true)).toBe(false);
  });

  it('stays everywhere else, including a record page and pages whose path only resembles settings or a database', () => {
    for (const p of ['/w/ws', '/w/ws/d/db1/r/rec', '/w/ws/d/db1/trash', '/w/ws/d/db1/relations', '/w/ws/d', '/w/ws/doc/d1', '/w/ws/me', '/w/ws/packs', '/w/ws/settingsfoo', null, undefined]) {
      expect(showQuickAddFab(p), String(p)).toBe(true);
    }
  });
});
