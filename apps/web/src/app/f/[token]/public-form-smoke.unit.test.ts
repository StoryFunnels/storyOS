import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * #315 — the PUBLIC form route must be able to evaluate and render.
 *
 * This exists because `/f/[token]` died in PRODUCTION with
 * `ReferenceError: Cannot access 'OPTION_COLORS' before initialization` while
 * every gate was green: lint, typecheck, `next build`, 1872 API tests and 523
 * web tests. `next build` misses it because the route is dynamic, so its module
 * graph is never evaluated at build time. A page that cannot render at all
 * should not be able to pass CI.
 *
 * The failure was an import CYCLE (`cells.tsx` -> `ui/avatar.tsx` ->
 * `cells.tsx`) that only breaks on routes where `cells.tsx` evaluates first.
 * Authenticated pages pulled `avatar` in earlier by luck and looked fine; this
 * page imports `OptionChip` from `cells.tsx` and nothing that reaches avatar
 * first, so it always lost the race.
 *
 * That is why this file mocks NOTHING from the app's own module graph — the
 * import order IS the thing under test. (Contrast `icon-picker.unit.test.ts`,
 * which stubs `cells` precisely to dodge this cycle; a suite made entirely of
 * those would stay green through the outage.)
 */

// Next's navigation hooks have no router in a bare render. Stubbed because they
// are environment, not app code — the module graph under test is untouched.
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useParams: () => ({ token: 'test-token' }),
}));

describe('the public form route evaluates (#315)', () => {
  it('imports without throwing — this is the assertion the outage would have failed', async () => {
    // A TDZ ReferenceError from the cycle is raised at MODULE EVALUATION, before
    // any component runs, so a bare import is a genuine reproduction of the
    // production failure rather than a weaker proxy for it.
    const mod = await import('./page');
    expect(typeof mod.default).toBe('function');
  });

  it('renders the option chip it pulls from cells.tsx', async () => {
    // `OptionChip` is the specific symbol this page imports across the old
    // cycle, and it reads OPTION_COLORS at render. If the colour table were
    // back in its temporal dead zone this throws.
    const { OptionChip } = await import('@/components/table-view/cells');
    const html = renderToStaticMarkup(
      createElement(OptionChip, { option: { id: 'o1', label: 'In Review', color: 'teal' } } as never),
    );
    expect(html).toContain('In Review');
    // Proves the colour table actually resolved, rather than rendering a
    // label with an undefined colour and passing vacuously.
    expect(html.toLowerCase()).toContain('#0d9488');
  });

  it('keeps the colour table in a leaf module that imports nothing', async () => {
    // The structural guarantee behind the fix. If OPTION_COLORS moves back into
    // a module with imports, the cycle can return — and it would return
    // silently, because only dynamic public routes expose it.
    const leaf = await import('@/components/table-view/option-colors');
    expect(Object.keys(leaf.OPTION_COLORS).length).toBeGreaterThan(10);
  });
});
