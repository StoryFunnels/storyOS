import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { agentSystemKey, isMembersDatabase } from '@/lib/system-databases';
import { hiddenSectionModel } from '@/lib/hidden-section';

/**
 * Ticket #1273 — shell fidelity against the prototype (measured at 1270, light). Source-level pins, in the style of the other
 * sidebar tests: the geometry lives in class strings, so the class strings are what drifts.
 */
const read = (name: string) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), 'utf8');
const rowSrc = read('sidebar-row.tsx');
const sidebarSrc = read('sidebar.tsx');
const aiSrc = read('sidebar-ai-section.tsx');

describe('item 2: tree rows are 22px with a 12px label', () => {
  it('SidebarRow, the one place that owns row geometry, is h-[22px] with the text-label (12px) step', () => {
    expect(rowSrc).toMatch(/group relative flex h-\[22px\] items-center justify-between rounded pr-2 text-label/);
    expect(rowSrc).not.toMatch(/group relative flex h-6\b/);
    expect(rowSrc).not.toMatch(/justify-between rounded pr-2 text-body/);
  });

  it('KEEPS the finger-sized phone heights: the density change is desktop-only', () => {
    expect(rowSrc).toContain("lens ? 'max-md:h-8' : 'max-md:h-[34px]'");
  });

  it('KEEPS the space header at 24px: the prototype\'s space header is taller than a row', () => {
    expect(sidebarSrc).toMatch(/group sticky z-20 h-6 /);
  });

  it('no row link restates text-body: children inherit the row\'s size, or the two drift again', () => {
    for (const src of [aiSrc, sidebarSrc]) {
      expect(src).not.toMatch(/flex min-w-0 flex-1 items-center gap-2 text-body/);
    }
  });
});

/**
 * #1273 (send-back) — the 13px guard is DERIVED, not a hand list. The first version scanned two named files and missed Personal
 * and every Settings row. Now the file set is "every component under src/components that renders a SidebarRow", found by scanning,
 * so a new row kind in a new file is covered the moment it exists. Any 13px class in those files must be listed with a reason.
 */
describe('item 2 (derived guard): no 13px label class in any file that renders a SidebarRow', () => {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}${e.name}/`) : [`${dir}${e.name}`]));
  const rowFiles = walk(root).filter((f) => f.endsWith('.tsx') && !f.endsWith('sidebar-row.tsx') && /<SidebarRow\b/.test(readFileSync(f, 'utf8')));
  const THIRTEEN = /\btext-body\b|\btext-sm\b|\btext-\[13px\]/;
  // [file suffix, source fragment, reason]. Everything here is NOT a tree-row label. Phone drawer: no 13px class is needed there
  // (rows are 34px/44px by height only, the label stays 12px), so nothing is exempt on the finger-size rule.
  const EXCEPTIONS: Array<[string, string, string]> = [
    ['sidebar.tsx', 'bg-primary text-body font-bold', 'the 34px "+" button glyph, not a row label'],
    ['sidebar.tsx', 'className="text-body" />', 'EntityIcon emoji glyph size (x2: document, folder), not the label'],
    ['sidebar.tsx', 'px-3 py-1 text-body', 'dialog buttons (Cancel / Confirm)'],
    ['sidebar.tsx', 'px-2 py-1 text-body text-ink outline-none', 'dialog text input'],
    ['sidebar.tsx', '<p className="text-body text-muted">', 'delete-database dialog paragraph'],
    ['sidebar-view-row.tsx', 'justify-center text-[13px]', 'emoji glyph of a view\'s database icon'],
    ['personal-section.tsx', 'px-2 py-1.5 text-left text-body', 'template-picker dialog option, not a tree row'],
  ];

  it('finds the row files by scanning (sidebar, AI section, view row, personal, settings menu)', () => {
    const names = rowFiles.map((f) => f.slice(root.length));
    for (const n of ['sidebar.tsx', 'sidebar-ai-section.tsx', 'sidebar-view-row.tsx', 'personal-section.tsx', 'settings/settings-sidebar-menu.tsx']) {
      expect(names).toContain(n);
    }
  });

  it('every 13px class in those files is a listed non-label exception', () => {
    const offenders: string[] = [];
    for (const f of rowFiles) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line) || !THIRTEEN.test(line)) return;
        const ok = EXCEPTIONS.some(([file, frag]) => f.endsWith(file) && line.includes(frag));
        if (!ok) offenders.push(`${f.slice(root.length)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the exceptions are not stale: each still matches a line (an exception outliving its line would hide a future regression)', () => {
    for (const [file, frag] of EXCEPTIONS) {
      const hit = rowFiles.filter((f) => f.endsWith(file)).some((f) => readFileSync(f, 'utf8').split('\n').some((l) => l.includes(frag) && THIRTEEN.test(l)));
      expect(hit, `${file} :: ${frag}`).toBe(true);
    }
  });

  it('the drag ghost and the inline rename input match the 12px row label', () => {
    expect(sidebarSrc).toMatch(/px-2 py-\[3px\] text-label text-ink shadow/);
    // The inline rename input is the shared RenameInput (ticket #1301): its 12px label size is pinned here.
    expect(read('ui/rename-input.tsx')).toMatch(/px-1 py-0\.5 text-label text-ink'/);
  });
});

describe('item 3: ONE tier-label style (AI, Spaces, Favorites share it)', () => {
  const tierSrc = read('sidebar-tier-label.tsx');

  it('the shared label is mono, 9px, 0.16em tracking, caps, in the neutral muted colour', () => {
    expect(tierSrc).toMatch(/font-mono text-\[9px\] font-normal uppercase/);
    expect(tierSrc).toContain('tracking-[0.16em]');
    expect(tierSrc).toMatch(/text-muted'/);
    expect(tierSrc).not.toMatch(/text-faint/); // a label is prose; faint is the glyph colour and fails 4.5:1
  });

  it('Spaces and Favorites go through SidebarTierLabel, not a hand-rolled span/div', () => {
    expect(sidebarSrc).toMatch(/<SidebarTierLabel[^>]*>Spaces<\/SidebarTierLabel>/);
    expect(sidebarSrc).toMatch(/<SidebarTierLabel[^>]*>Favorites<\/SidebarTierLabel>/);
    expect(sidebarSrc).not.toMatch(/uppercase tracking-wider text-muted">Spaces</);
  });

  it('KEEPS the AI label gold (text-accent-text, in the agent allow-list file only) and a notch heavier', () => {
    expect(aiSrc).toMatch(/<SidebarTierLabel className="font-semibold text-accent-text">AI<\/SidebarTierLabel>/);
    expect(tierSrc).not.toMatch(/accent/); // gold must not enter the shared file (gold-agents-only)
  });
});

describe('item 4: the workspace header is 40px, name 14px/700 with -0.01em tracking', () => {
  const switcher = sidebarSrc.slice(sidebarSrc.indexOf('function WorkspaceSwitcher'), sidebarSrc.indexOf('The "Hidden" section'));

  it('the trigger is h-10 and the name is text-prose font-bold tracking-[-0.01em]', () => {
    expect(switcher).toMatch(/flex h-10 w-full items-center gap-2 border-b/);
    expect(switcher).toMatch(/text-prose font-bold tracking-\[-0\.01em\] text-ink/);
    expect(switcher).not.toMatch(/font-semibold/);
  });

  it('KEEPS the finger-sized 44px header in the phone drawer', () => {
    expect(switcher).toContain('max-md:h-11');
  });
});

describe('item 5: the search field is 28px tall with 12px text and 9px side padding', () => {
  const field = sidebarSrc.slice(sidebarSrc.indexOf('onClick={openPalette}') - 420, sidebarSrc.indexOf('onClick={openPalette}'));

  it('h-7, px-[9px], text-label', () => {
    expect(field).toMatch(/flex h-7 w-full items-center gap-2/);
    expect(field).toContain('px-[9px]');
    expect(field).toContain('text-label');
    expect(field).not.toMatch(/py-1 text-body/);
  });

  it('KEEPS the finger-sized phone minimum and the ⌘K hint', () => {
    expect(field).toContain('max-md:min-h-11');
    expect(sidebarSrc).toContain('{paletteKeys}');
  });
});

describe('item 6: New space / From template move into the Spaces + menu; Members leaves the tree; Hidden only when something is hidden', () => {
  const menuSrc = read('sidebar-spaces-add-menu.tsx');

  it('the menu carries New space, From template and New group (the group dialog is kept, not dropped)', () => {
    expect(menuSrc).toMatch(/<DropdownMenuItem[^>]*onSelect=\{onNewSpace\}>[\s\S]*?New space/);
    expect(menuSrc).toMatch(/<DropdownMenuItem[^>]*onSelect=\{onFromTemplate\}>[\s\S]*?From template/);
    expect(menuSrc).toMatch(/<DropdownMenuItem[^>]*>[\s\S]*?New group/);
    expect(menuSrc).toContain('title="New group"');
  });

  it('the trigger has an accessible name and is a real button (keyboard reachable)', () => {
    expect(menuSrc).toContain('aria-label="Add to Spaces"');
    expect(menuSrc).toMatch(/<button\s+type="button"/);
  });

  it('the tree no longer carries the two rows, and nothing else made a second hand-rolled copy', () => {
    expect(sidebarSrc).not.toContain('function NewSpaceButton');
    expect(sidebarSrc).not.toContain('function NewGroupButton');
    expect(sidebarSrc).not.toMatch(/<LayoutTemplate className="h-3\.5 w-3\.5" \/> From template/);
    expect(sidebarSrc).not.toMatch(/<Plus className="h-3\.5 w-3\.5" \/> New space/);
  });

  it('KEEPS the gate: the + is rendered only under the canEdit check the old rows shared (a guest never had them)', () => {
    expect(sidebarSrc).toMatch(/\{canEdit && \(\s*<SidebarSpacesAddMenu/);
    expect(sidebarSrc).toMatch(/\{canEdit && galleryOpen && \(\s*<TemplateGalleryDialog/);
    expect(sidebarSrc).toContain("const canEdit = workspace.data?.role !== 'guest';");
  });

  it('KEEPS what New space did: untitled space, next colour, marked for focus, opened, drawer closed, error toast', () => {
    const fn = sidebarSrc.slice(sidebarSrc.indexOf('const createUntitledSpace'), sidebarSrc.indexOf('useSidebarNavWidth();'));
    for (const piece of ['UNTITLED_SPACE', 'nextSpaceColor(spaces.data ?? [])', 'markNewSpace(created.id)', 'router.push(`/w/${ws}/s/${created.id}`)', 'onCloseMobile?.()', "toast.error('Could not create space')"]) {
      expect(fn).toContain(piece);
    }
  });

  it('Members: left out of the space\'s database list by the system flag, never by name alone', () => {
    expect(sidebarSrc).toMatch(/agentSystemKey\(d\) === null && !isMembersDatabase\(d\)/);
    expect(isMembersDatabase({ name: 'Members', isSystem: true })).toBe(true);
    expect(isMembersDatabase({ name: ' members ', isSystem: true })).toBe(true);
  });

  it('KEEPS a person\'s OWN database called "Members" (no flag), and every other system database, in the tree', () => {
    expect(isMembersDatabase({ name: 'Members', isSystem: false })).toBe(false);
    expect(isMembersDatabase({ name: 'Members' })).toBe(false);
    expect(isMembersDatabase({ name: 'Tasks', isSystem: true })).toBe(false);
    expect(isMembersDatabase(null)).toBe(false);
    // The Agentic OS databases are still handled by their own predicate, untouched.
    expect(agentSystemKey({ name: 'Agents', isSystem: true })).toBe('agents');
    expect(agentSystemKey({ name: 'Members', isSystem: true })).toBeNull();
  });

  it('Hidden renders nothing at zero and a collapsed section when something is hidden', () => {
    const none = hiddenSectionModel({ spaces: [{ id: 's1' }], databases: [], isHidden: () => false, systemOnlySpaceIds: new Set() });
    expect(none.count).toBe(0);
    const some = hiddenSectionModel({ spaces: [{ id: 's1' }], databases: [], isHidden: (k, id) => k === 'space' && id === 's1', systemOnlySpaceIds: new Set() });
    expect(some.count).toBe(1);
    expect(sidebarSrc).toContain('if (count === 0) return null;');
    expect(sidebarSrc).toContain('const [open, setOpen] = useState(false);'); // collapsed unless this person opened it
  });

  it('records the platform-monospace ruling where the tier label lives (no font file)', () => {
    expect(read('sidebar-tier-label.tsx')).toContain('platform stack is ACCEPTED');
  });
});
