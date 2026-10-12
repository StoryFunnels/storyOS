import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * #844 — the workspace mark is drawn ONCE, and the workspace menu is written
 * ONCE.
 *
 * #742 phase 6 gave the rail its own workspace avatar and deliberately kept the
 * panel header's 20x20 mark as well, on the reasoning that the rail and the
 * panel are independent surfaces. They are not: `SidebarRail` renders inside
 * `Sidebar`, and the layout hides the whole Sidebar wrapper with
 * `collapsed && 'md:hidden'`. So the two were never in a state where only one
 * was visible — the product simply drew the same mark twice, 34px apart, at two
 * different radii, and the first screenshot anyone took of it read as a bug.
 *
 * This is pinned in the source rather than asserted on a render because that is
 * how this file's sibling (`sidebar-row-style.unit.test.ts`) pins the sidebar's
 * other twice-regressed invariant, and because the failure mode here is textual:
 * somebody pastes the mark or the menu back in. A DOM test would pass on a
 * second copy that is merely hidden; this does not.
 */

const SRC = readFileSync(fileURLToPath(new URL('./sidebar.tsx', import.meta.url)), 'utf8');

/** The workspace mark: a single uppercased initial with 'S' as the fallback. */
const MARK = /\?\.\[0\]\?\.toUpperCase\(\)\s*\?\?\s*'S'/g;

describe('#844 — one workspace mark, one workspace menu', () => {
  it('draws the workspace initial exactly once', () => {
    const hits = SRC.match(MARK) ?? [];
    expect(
      hits.length,
      'A second workspace mark is back in sidebar.tsx. The rail draws it; the ' +
        'panel header must not draw it again — see #844 and the comment on ' +
        'RailWorkspaceButton before adding one.',
    ).toBe(1);
  });

  it('writes the workspace menu body exactly once', () => {
    // "New workspace" is the last item of the menu, so counting it counts menus.
    const hits = SRC.match(/New workspace/g) ?? [];
    expect(
      hits.length,
      'The workspace menu exists in more than one place again. Both triggers ' +
        'must render <WorkspaceMenuContent>; two copies drift the moment ' +
        'somebody adds an item to one of them.',
    ).toBe(1);
  });

  it('has both triggers render the shared menu component', () => {
    const uses = SRC.match(/<WorkspaceMenuContent\b/g) ?? [];
    expect(uses.length, 'Expected the rail trigger and the header trigger to share one menu.').toBe(2);
  });

  it('keeps the header trigger, because it is the only switcher if the rail ever survives collapse', () => {
    expect(SRC).toContain('function WorkspaceSwitcher(');
    // The name and the chevron are what make the header read as a control now
    // that it carries no mark. Losing either turns it into plain text.
    expect(SRC).toContain('<ChevronsUpDown');
  });

  it('keeps the workspace query in the triggers, not in the menu content', () => {
    // Radix only mounts menu content once the menu opens. A useQuery moved into
    // WorkspaceMenuContent would silently turn an eager fetch into a lazy one
    // and show an empty list on first open — no test would otherwise catch it.
    const menuStart = SRC.indexOf('function WorkspaceMenuContent(');
    const menuEnd = SRC.indexOf('function useWorkspaceList(');
    expect(menuStart).toBeGreaterThan(-1);
    expect(menuEnd).toBeGreaterThan(menuStart);
    expect(SRC.slice(menuStart, menuEnd)).not.toContain('useQuery');
  });
});
