import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PackVisual } from '@/components/pack-visual';
import { TooltipProvider } from '@/components/ui/tooltip';
import { markNames, markTip, notifiesPeople } from './pack-marks';

const manifest = {
  agents: [{ name: 'Triage' }, { name: 'Digest' }],
  automations: [
    { name: 'Tell the assignee', actions: [{ type: 'notify_user' }] },
    { name: 'Set the date', actions: [{ type: 'update_record' }] },
    { name: 'Ping the lead', actions: [{ type: 'update_record' }, { type: 'notify_user' }] },
  ],
};

describe('markNames (#1176 — the tooltip names come from the pack own items)', () => {
  it('lists every agent, and only the automations that tell people', () => {
    expect(markNames(manifest, 'agent')).toEqual(['Triage', 'Digest']);
    expect(markNames(manifest, 'notifies')).toEqual(['Tell the assignee', 'Ping the lead']);
  });
  it('is empty for a manifest not loaded yet, or a pack without them, never a placeholder', () => {
    expect(markNames(undefined, 'agent')).toEqual([]);
    expect(markNames({}, 'notifies')).toEqual([]);
    expect(markNames({ agents: [{ name: '  ' }, {}] }, 'agent')).toEqual([]);
  });
  it('notifiesPeople is the API rule: a notify_user action anywhere in the list', () => {
    expect(notifiesPeople({ actions: [{ type: 'a' }, { type: 'notify_user' }] })).toBe(true);
    expect(notifiesPeople({ actions: [] })).toBe(false);
    expect(notifiesPeople({})).toBe(false);
  });
});

describe('the rendered card marks are labels, not buttons (ticket #1176)', () => {
  const pack = {
    slug: 'dev-tracker',
    name: 'Dev Tracker',
    preview: { databases: 3, views: 4, automations: 2, agents: 1 },
    workflow: null,
  };
  const render = (marks: { agent: boolean; notifies: boolean }) =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(TooltipProvider, null, createElement(PackVisual, { pack: { ...pack, marks }, manifest })),
      ),
    );
  it('draws Agent and Notifies as plain spans: no button, no chip background, help cursor', () => {
    const html = render({ agent: true, notifies: true });
    expect(html).toContain('data-testid="pack-mark-agent"');
    expect(html).toContain('data-testid="pack-mark-notifies"');
    const marks = [...html.matchAll(/<span[^>]*data-testid="pack-mark-[a-z]+"[^>]*>/g)].map((m) => m[0]);
    expect(marks).toHaveLength(2);
    for (const m of marks) {
      expect(m).toContain('cursor-help');
      expect(m).toContain('text-muted');
      expect(m).not.toMatch(/\bbg-|border|rounded|px-/);
      expect(m).not.toContain('role=');
      expect(m).not.toContain('tabindex');
    }
    expect(html).not.toContain('<button');
  });
  it('draws only the marks the pack has', () => {
    const html = render({ agent: false, notifies: true });
    expect(html).not.toContain('pack-mark-agent');
    expect(html).toContain('pack-mark-notifies');
    expect(render({ agent: false, notifies: false })).not.toContain('pack-mark-');
  });
});

describe('markTip (Dara copy, ticket #1176)', () => {
  it('one name: the exact sentences from the design', () => {
    expect(markTip('agent', ['Triage'])).toBe('Comes with an agent: Triage');
    expect(markTip('notifies', ['Tell the assignee'])).toBe('Comes with an automation that tells people: Tell the assignee');
  });
  it('several names lead with the count', () => {
    expect(markTip('agent', ['A', 'B'])).toBe('Comes with 2 agents: A, B');
    expect(markTip('notifies', ['A', 'B', 'C'])).toBe('Comes with 3 automations that tell people: A, B, C');
  });
  it('no names yet: the sentence without a name, never an invented one', () => {
    expect(markTip('agent', [])).toBe('Comes with an agent');
    expect(markTip('notifies', [])).toBe('Comes with an automation that tells people');
  });
});
