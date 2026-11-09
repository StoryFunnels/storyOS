import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAgentAction, isAiSource } from '@/lib/governance';
import { sourceBadgeTitle } from './panels';

const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
const skillBits = readFileSync(new URL('../skills/skill-bits.tsx', import.meta.url), 'utf8');

/**
 * Ticket #1206 — gold means an AI acting (ticket #831/#1163). Agent and MCP edits wear the accent; an automation is a rule a person
 * configured, so it stays neutral (Dara's ruling); a human edit shows nothing. ONE predicate, `isAiSource`, decides it for both source
 * badges (the Activity panel's and the record history's), so they cannot drift apart again.
 */
const panels = readFileSync(new URL('./panels.tsx', import.meta.url), 'utf8');
const history = readFileSync(new URL('./record-history.tsx', import.meta.url), 'utf8');
const panelsBadge = panels.slice(panels.indexOf('function SourceBadge'), panels.indexOf('export function ActivityPanel'));
const historyBadge = history.slice(history.indexOf('function SourceBadge'), history.indexOf('/**\n * #39 — the record history dialog'));

describe('isAiSource: the one rule for gold on a source badge', () => {
  it.each([
    ['agent', true],
    ['mcp', true],
    ['automation', false],
    ['human', false],
    [null, false],
    [undefined, false],
    ['', false],
  ])('%s → %s', (source, expected) => {
    expect(isAiSource(source as string | null | undefined)).toBe(expected);
  });

  it('is the rule the Agent actions page already used (an audit row is an agent action only for an AI source)', () => {
    expect(isAgentAction({ kind: 'event', source: 'agent' })).toBe(true);
    expect(isAgentAction({ kind: 'event', source: 'mcp' })).toBe(true);
    expect(isAgentAction({ kind: 'event', source: 'automation' })).toBe(false);
    expect(isAgentAction({ kind: 'field_change', source: 'agent' })).toBe(false);
  });
});

describe('both source badges decide gold with that one predicate', () => {
  it('the Activity panel badge imports and calls isAiSource, and carries the accent pair for it', () => {
    expect(panels).toContain("import { isAiSource } from '@/lib/governance'");
    expect(panelsBadge).toMatch(/isAiSource\(source\)\s*\?\s*'bg-accent-soft text-accent-text'/);
  });

  it('the record history badge imports and calls isAiSource, and carries the accent for it', () => {
    expect(history).toContain("import { isAiSource } from '@/lib/governance'");
    expect(historyBadge).toMatch(/isAiSource\(source\)\s*\?\s*'bg-accent-soft/);
  });

  it('neither badge golds by "anything that is not human" any more', () => {
    expect(panelsBadge).not.toMatch(/source === 'human' \?[^:]*:\s*'bg-accent-soft/);
    expect(historyBadge).not.toMatch(/source === 'human' \?[^:]*:\s*'bg-accent-soft/);
  });

  it('an automation keeps the neutral badge in the Activity panel (bg-hover, text-primary-text), with its icon and label', () => {
    expect(panelsBadge).toContain("'bg-hover text-primary-text'");
    expect(panelsBadge).toContain('automation: { icon: Workflow, label:');
  });

  it('shows nothing for a human edit', () => {
    expect(panelsBadge).toMatch(/if \(source === 'human'\) return null;/);
  });
});

describe('the tooltip names the agent when it is known', () => {
  it('"Made by Triage Bot, an agent, not typed by a person"', () => {
    expect(sourceBadgeTitle('agent', 'Triage Bot')).toBe('Made by Triage Bot, an agent, not typed by a person');
  });

  it('keeps the general sentence without a name (null, empty, blank)', () => {
    for (const n of [null, undefined, '', '   ']) {
      expect(sourceBadgeTitle('agent', n)).toBe('This event was made by an agent, not typed by a person');
    }
  });

  it('the other sources keep their sentences and never borrow an agent name', () => {
    expect(sourceBadgeTitle('mcp', 'Triage Bot')).toBe('This event was made by an MCP client, not typed by a person');
    expect(sourceBadgeTitle('automation', 'Triage Bot')).toBe('This event was made by an automation, not typed by a person');
  });
});

/** WCAG contrast of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** The value of a custom property in the light block (first declaration) or the dark block (the one after `:root[data-theme='dark']`). */
function token(name: string, theme: 'light' | 'dark'): string {
  const dark = css.indexOf(":root[data-theme='dark'],");
  const scope = theme === 'light' ? css.slice(0, dark) : css.slice(dark);
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(scope);
  if (!m) throw new Error(`--${name} not found in the ${theme} block`);
  const value = m[1]!.trim();
  const ref = /^var\(--([a-z-]+)\)$/.exec(value);
  return ref ? token(ref[1]!, theme) : value;
}

describe('every gold source badge uses the contrast-checked text token (Vera, ticket #1206)', () => {
  it('the three badges that draw gold text all use text-accent-text, never the raw accent', () => {
    for (const [name, src] of [['Activity panel', panelsBadge], ['record history', historyBadge], ['skill source mark', skillBits]] as const) {
      expect(src, name).toContain('text-accent-text');
      expect(src, name).not.toContain('text-[var(--accent)]');
      expect(src, name).not.toMatch(/\btext-accent(?![-\w])/);
    }
  });

  it('the skill source mark decides gold with isAiSource too', () => {
    expect(skillBits).toContain("import { isAiSource } from '@/lib/governance'");
    expect(skillBits).toContain('!isAiSource(source)');
  });

  it.each(['light', 'dark'] as const)('--accent-text on --accent-soft clears AA (4.5:1) in %s mode', (theme) => {
    const text = token('accent-text', theme);
    const fill = token('accent-soft', theme);
    expect(contrast(text, fill)).toBeGreaterThanOrEqual(4.5);
  });

  it('the raw --accent on --accent-soft does NOT clear AA in light mode: the reason the raw token is not used for text', () => {
    expect(contrast(token('accent', 'light'), token('accent-soft', 'light'))).toBeLessThan(4.5);
  });
});
