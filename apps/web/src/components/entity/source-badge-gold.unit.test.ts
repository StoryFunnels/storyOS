import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #1206 — the Activity panel's source badge is the original "gold means agency" mark (ticket #831): an edit made by an agent,
 * an automation or an MCP client wears the accent, a human edit wears nothing. Ticket #1347's neutral-token sweep turned it neutral
 * by accident. This pins the accent classes on the badge so it cannot silently go neutral again.
 */
const source = readFileSync(new URL('./panels.tsx', import.meta.url), 'utf8');
const badge = source.slice(source.indexOf('function SourceBadge'), source.indexOf('export function ActivityPanel'));

describe('the Activity panel source badge', () => {
  it('finds the badge it is meant to pin', () => {
    expect(badge).toContain('"human"'.replace(/"/g, "'"));
    expect(badge).toContain('This event was made by');
  });

  it('wears the accent for an agent, automation or MCP edit', () => {
    expect(badge).toContain('bg-accent-soft');
    expect(badge).toContain('text-accent-text');
  });

  it('is not the neutral badge the #1347 sweep produced', () => {
    expect(badge).not.toContain('bg-hover px-1.5 py-0.5 text-micro font-medium text-primary-text');
  });

  it('shows nothing for a human edit', () => {
    expect(badge).toMatch(/if \(source === 'human'\) return null;/);
  });
});
