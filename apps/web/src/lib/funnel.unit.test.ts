import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  authEventFromSearch,
  captureFirstTouch,
  firstTouchProperties,
  parseFirstTouch,
  readFirstTouch,
  stripAuthEvent,
  withSurface,
} from './funnel';

function memoryStore(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set('so_first_touch', initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    raw: () => data.get('so_first_touch'),
  };
}

describe('parseFirstTouch (ticket #818 AC3)', () => {
  it('keeps the four attribution params that are present', () => {
    expect(parseFirstTouch('?utm_source=docs&utm_medium=nav&utm_campaign=/guide&ref=abc&other=1')).toEqual({
      utm_source: 'docs',
      utm_medium: 'nav',
      utm_campaign: '/guide',
      ref: 'abc',
    });
  });
  it('treats absent and blank params as ABSENT, never as empty strings', () => {
    expect(parseFirstTouch('')).toEqual({});
    expect(parseFirstTouch('?utm_source=&utm_medium=%20%20')).toEqual({});
  });
  it('bounds a hostile value', () => {
    expect(parseFirstTouch(`?utm_source=${'x'.repeat(500)}`).utm_source).toHaveLength(200);
  });
});

describe('firstTouchProperties', () => {
  it('prefixes only what exists', () => {
    expect(firstTouchProperties({ utm_source: 'docs', ref: 'abc' })).toEqual({
      first_touch_utm_source: 'docs',
      first_touch_ref: 'abc',
    });
    expect(firstTouchProperties({})).toEqual({});
  });
});

describe('captureFirstTouch — first touch wins', () => {
  it('stores the landing params, and a later page cannot overwrite them', () => {
    const store = memoryStore();
    captureFirstTouch('?utm_source=docs&utm_medium=nav', store);
    captureFirstTouch('?utm_source=newsletter', store);
    expect(readFirstTouch(store)).toEqual({ utm_source: 'docs', utm_medium: 'nav' });
  });
  it('stores nothing for a page with no params, so a later landing can still be the first touch', () => {
    const store = memoryStore();
    captureFirstTouch('', store);
    expect(store.raw()).toBeUndefined();
    captureFirstTouch('?utm_source=docs', store);
    expect(readFirstTouch(store)).toEqual({ utm_source: 'docs' });
  });
  it('survives unavailable or corrupt storage', () => {
    expect(readFirstTouch(memoryStore('not json'))).toEqual({});
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => captureFirstTouch('?utm_source=docs', broken)).not.toThrow();
    expect(readFirstTouch(broken)).toEqual({});
  });
});

describe('the Google redirect marker (ticket #818 AC1, AC2)', () => {
  it('maps a new account to a sign-up and a returning one to a login', () => {
    expect(authEventFromSearch('?auth_event=signed_up&method=google')).toEqual({ event: 'user_signed_up', method: 'google' });
    expect(authEventFromSearch('?auth_event=logged_in&method=google')).toEqual({ event: 'user_logged_in', method: 'google' });
  });
  it('ignores anything that is not one of the two known markers', () => {
    expect(authEventFromSearch('')).toBeNull();
    expect(authEventFromSearch('?auth_event=signed_up')).toBeNull();
    expect(authEventFromSearch('?auth_event=signed_up&method=email')).toBeNull();
    expect(authEventFromSearch('?auth_event=purchase&method=google')).toBeNull();
  });
  it('strips the marker and keeps every other param', () => {
    expect(stripAuthEvent('?auth_event=signed_up&method=google&utm_source=docs')).toBe('?utm_source=docs');
    expect(stripAuthEvent('?auth_event=logged_in&method=google')).toBe('');
  });
});

const src = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(src, p), 'utf8');
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function allSources(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const f = join(dir, n);
    if (statSync(f).isDirectory()) out.push(...allSources(f));
    else if (/\.tsx?$/.test(n) && !/\.test\./.test(n)) out.push(f);
  }
  return out;
}

describe('where the events are emitted', () => {
  it('the Google button does not capture user_logged_in on the click (AC2)', () => {
    const login = code(read('app/(auth)/login/page.tsx'));
    const google = login.slice(login.indexOf("provider: 'google'") - 400, login.indexOf("provider: 'google'") + 400);
    expect(google).not.toMatch(/posthog\.capture/);
    expect(google).toMatch(/newUserCallbackURL: GOOGLE_NEW_USER_CALLBACK/);
  });
  it('the email sign-up still emits user_signed_up with its method and the first touch', () => {
    const signup = code(read('app/(auth)/signup/page.tsx'));
    expect(signup).toMatch(/posthog\.capture\('user_signed_up'/);
    expect(signup).toMatch(/method: 'email'/);
    expect(signup).toMatch(/firstTouchProperties/);
  });
  it('every app event gets surface: app from ONE place, not per call site (AC4)', () => {
    expect(code(read('../instrumentation-client.ts'))).toMatch(/before_send: \(event\) => withSurface\(event\)/);
    const perSite = allSources(src).filter((f) => /posthog\.capture\([^)]*surface/.test(code(readFileSync(f, 'utf8'))));
    expect(perSite).toEqual([]);
  });
  it('keeps the existing event names (AC5: renaming breaks dashboards already pointed at them)', () => {
    const names = new Set<string>();
    for (const f of allSources(src)) {
      for (const m of code(readFileSync(f, 'utf8')).matchAll(/posthog\.capture\(\s*'([a-z_]+)'/g)) names.add(m[1]!);
    }
    for (const name of [
      'csv_import_completed',
      'integration_disconnected',
      'invite_accepted',
      'invite_sent',
      'mcp_endpoint_copied',
      'mcp_setup_check_failed',
      'mcp_setup_check_started',
      'mcp_setup_check_succeeded',
      'mcp_setup_client_selected',
      'mcp_setup_started',
      'onboarding_pack_installed',
      'plan_upgrade_clicked',
      'share_access_granted',
      'template_installed',
      'trial_started',
      'user_logged_in',
      'user_signed_up',
      'workspace_created',
    ]) {
      expect(names, name).toContain(name);
    }
  });
});

describe('withSurface (ticket #818 AC4, after the send-back)', () => {
  it('stamps surface on every event, including the $-events a super property missed', () => {
    for (const name of ['$pageview', '$identify', '$set', '$pageleave', 'workspace_created']) {
      expect(withSurface({ event: name, properties: { a: 1 } } as never)).toMatchObject({ properties: { surface: 'app', a: 1 } });
    }
  });
  it('works on an event with no properties yet, and leaves a dropped event dropped', () => {
    expect(withSurface({ event: '$pageview' } as never)).toMatchObject({ properties: { surface: 'app' } });
    expect(withSurface(null)).toBeNull();
  });
  it('does not overwrite a surface an event already carries', () => {
    expect(withSurface({ properties: { surface: 'docs' } })).toEqual({ properties: { surface: 'docs' } });
  });
  it('does not depend on registration, so posthog.reset() cannot remove it', () => {
    expect(code(read('../instrumentation-client.ts'))).not.toMatch(/posthog\.register/);
  });
});
