import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1006 — three small things that nothing else would catch if they came back, pinned by reading the source.
 */
const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');

describe('#1006 leftovers', () => {
  it('the phone hamburger has an accessible name (a title alone is not reliably one)', () => {
    const layout = src('app/w/[ws]/layout.tsx');
    const at = layout.indexOf('onClick={() => setMobileOpen(true)}');
    expect(at).toBeGreaterThan(-1);
    expect(layout.slice(at, at + 400)).toContain('aria-label="Open navigation"');
  });

  it('the sidebar drag grip is a hint and opts out of the touch "always visible" rule; the rule honours it', () => {
    expect(src('components/sidebar-row.tsx')).toMatch(/<GripVertical data-hint-only/);
    const css = src('app/globals.css');
    expect(css).toMatch(/\.opacity-0\[class\*='hover'\]\[class\*=':opacity-100'\]:not\(\[data-hint-only\]\)/);
  });

  it('the pull-request page goes back to My Work’s Pull requests tab, not the Reviews redirect', () => {
    const page = src('app/w/[ws]/reviews/[owner]/[repo]/[number]/page.tsx');
    expect(page).toContain('/me?tab=pull-requests');
    expect(page).not.toMatch(/href=\{`\/w\/\$\{ws\}\/reviews`\}/);
    expect(page).toContain('Pull requests');
  });

  it('no stale comment still says Reviews is a sidebar Collections row', () => {
    expect(src('components/sidebar.tsx')).not.toContain('Reviews and Business Packs become Collections rows');
  });
});
