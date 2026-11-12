import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOTIFICATION_VERBS, UNKNOWN_NOTIFICATION_VERB, notificationVerb } from './notification-verbs';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** The types the API can emit, read from the API source: the one `NotificationType` union and its single insert path. */
function apiNotificationTypes(): string[] {
  const src = read('../../../api/src/notifications/notifications.service.ts');
  const start = src.indexOf('export type NotificationType =');
  expect(start).toBeGreaterThan(-1);
  // The union ends at the first member followed by `;` (the doc comments inside never contain `';`).
  const body = src.slice(start, src.indexOf("';", start) + 2);
  return [...body.matchAll(/^\s*\|\s*'([a-z0-9_]+)'/gm)].map((m) => m[1]!);
}

describe('every notification type the API can emit has a verb', () => {
  const types = apiNotificationTypes();
  it('reads a plausible, complete list from the API source (guards the parser itself)', () => {
    expect(types.length).toBeGreaterThanOrEqual(20);
    expect(types).toContain('invite_accepted');
    expect(types).toContain('assigned');
    expect(types).toContain('agent_budget_paused');
    expect(new Set(types).size).toBe(types.length);
  });
  it.each(types)('%s has its own sentence, not the unknown-type fallback', (t) => {
    expect(Object.prototype.hasOwnProperty.call(NOTIFICATION_VERBS, t)).toBe(true);
    expect(notificationVerb(t)).toBe(NOTIFICATION_VERBS[t as keyof typeof NOTIFICATION_VERBS]);
    expect(notificationVerb(t)).not.toBe(UNKNOWN_NOTIFICATION_VERB);
    expect(notificationVerb(t).trim().length).toBeGreaterThan(0);
  });
  it('has no verb for a type the API does not emit (a stale entry is a lie about the product)', () => {
    expect(Object.keys(NOTIFICATION_VERBS).sort()).toEqual([...types].sort());
  });
});

describe('an unknown notification type', () => {
  it('reads as neutral words and never as the raw code', () => {
    expect(notificationVerb('brand_new_thing')).toBe('sent you a notification');
    expect(notificationVerb('brand_new_thing')).not.toContain('brand_new_thing');
  });
  it('cannot reach Object.prototype', () => {
    expect(notificationVerb('constructor')).toBe(UNKNOWN_NOTIFICATION_VERB);
    expect(notificationVerb('toString')).toBe(UNKNOWN_NOTIFICATION_VERB);
  });
});

describe('both Inbox surfaces draw the verb through notificationVerb', () => {
  it.each([['./inbox-panel.tsx'], ['../app/w/[ws]/inbox/page.tsx']])('%s', (path) => {
    const text = read(path);
    expect(text).toContain('notificationVerb(');
    expect(text).not.toMatch(/VERBS\[/);
  });
});
