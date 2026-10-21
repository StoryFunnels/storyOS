import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { runStatusLabel } from '@/lib/run-labels';
import { RUNS_DOCS_URL, RUNS_EXPLAINER_HINT, RunsExplainerCard } from './runs-explainer';

const html = (collapsed: boolean) =>
  renderToStaticMarkup(
    createElement(RunsExplainerCard, {
      collapsed,
      onHide: () => undefined,
      onShow: () => undefined,
    }),
  );

describe('#976 runs explainer card', () => {
  it('shows the copy, the three status bullets and the docs link', () => {
    const out = html(false);
    expect(out).toContain('What is an automation run?');
    expect(out).toContain('A run is one time an automation rule did its job');
    expect(out).toContain('Awaiting approval');
    expect(out).toContain('Skipped (quota)');
    expect(out).toContain(`href="${RUNS_DOCS_URL}"`);
    // #997: the Agentic OS Runs database page (agent-runs) is the wrong target for this list.
    expect(RUNS_DOCS_URL).toBe('https://docs.storyos.dev/concepts/automations/');
    expect(out).not.toMatch(/MN-\d+/);
  });

  it('hiding collapses it to a "What is an automation run?" control and drops the card', () => {
    const out = html(true);
    expect(out).toContain('What is an automation run?');
    expect(out).not.toContain('data-testid="runs-explainer"');
    expect(out).not.toContain('A run is one time');
  });

  it("uses the status words the page's own labels use, so the copy cannot drift from them", () => {
    // The card's vocabulary is run-labels.ts's, tested together (#976 AC4, #997): rename a status and this fails.
    const out = html(false);
    for (const status of ['pending_approval', 'ok', 'error', 'skipped_quota']) expect(out).toContain(runStatusLabel(status));
  });

  it('the docs link is a plain link, not the gold accent (gold means agency, #831)', () => {
    const src = readFileSync(join(__dirname, 'runs-explainer.tsx'), 'utf8');
    expect(src).not.toMatch(/text-accent/);
  });

  it('has no hover-only control (#900): nothing is opacity-0 or revealed by group-hover', () => {
    const src = readFileSync(join(__dirname, 'runs-explainer.tsx'), 'utf8');
    expect(src).not.toMatch(/opacity-0|group-hover|invisible/);
  });

  it('persists per viewer through dismissed hints, never localStorage', () => {
    const src = readFileSync(join(__dirname, 'runs-explainer.tsx'), 'utf8');
    expect(src).toContain('useDismissedHints');
    expect(src).not.toMatch(/localStorage|sessionStorage/);
    expect(RUNS_EXPLAINER_HINT).toBe('agent-runs-explainer');
  });
});
