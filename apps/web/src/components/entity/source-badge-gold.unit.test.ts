import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isAgentAction, isAiSource } from '@/lib/governance';
import { sourceBadgeTitle } from './panels';

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
