import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #1193 — every Inbox surface names "who" through `notificationWho`, never an inline `actor?.name ?? …` ternary.
 * (Source-text guard, the same kind as inbox-gate.unit.test.ts: it stops a later surface re-growing its own copy; the
 * behaviour itself is covered in caused-by.unit.test.ts and was clicked through live.)
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const surfaces = [
  ['the full-page inbox', '../../app/w/[ws]/inbox/page.tsx'],
  ['the inbox slide-over', '../inbox-panel.tsx'],
] as const;

describe.each(surfaces)('%s', (_name, path) => {
  const text = read(path);
  it('names who through the shared helper', () => {
    expect(text).toMatch(/notificationWho\(/);
  });
  it('has no inline actor-name ternary left', () => {
    expect(text).not.toMatch(/actor\?\.name\s*\?\?/);
  });
});

describe('every approval decision announces through announceDecision', () => {
  it('useResolveApproval (the Inbox, the slide-over and the run detail card all send through it)', () => {
    const text = read('../inbox-panel.tsx');
    const hook = text.slice(text.indexOf('export function useResolveApproval'), text.indexOf('/** One tool call in a run'));
    expect(hook).toMatch(/announceDecision\(/);
    expect(hook).not.toMatch(/toast\.success/);
  });
});
