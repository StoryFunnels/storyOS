import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
    expect(out).toContain('What is a run?');
    expect(out).toContain('A run is one time an automation rule did its job');
    expect(out).toContain('Awaiting approval');
    expect(out).toContain('Skipped (quota)');
    expect(out).toContain(`href="${RUNS_DOCS_URL}"`);
    expect(RUNS_DOCS_URL).toBe('https://docs.storyos.dev/concepts/agent-runs/');
  });

  it('hiding collapses it to a "What are agent runs?" control and drops the card', () => {
    const out = html(true);
    expect(out).toContain('What are agent runs?');
    expect(out).not.toContain('data-testid="runs-explainer"');
    expect(out).not.toContain('A run is one time');
  });

  it("uses the status words the page's own filter chips use, so the copy cannot drift from them", () => {
    const page = readFileSync(join(__dirname, '../../app/w/[ws]/runs/page.tsx'), 'utf8');
    for (const word of ['OK', 'Failed', 'Skipped (quota)'])
      expect(page).toContain(`label: '${word}'`);
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
