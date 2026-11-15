import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #964 — a view type whose renderer reads `config.hidden_field_ids` must have a control in Display that
 * WRITES it. The first cut moved "Hide fields" into Display for the table only; the timeline's left panel
 * still honoured the setting and the UI could no longer change it (Vera, PR 1148). That is the
 * renderer/picker mismatch field-surfaces.md calls the bug, and nothing failed to compile.
 *
 * This reads source, as the DnD guard does: the property that matters is "every reader has a writer".
 */
const dir = __dirname;
const read = (f: string) => readFileSync(join(dir, f), 'utf8');

/** renderer file -> the view type it renders. A new reader must be added here, or the test below names it. */
const READERS: Record<string, string> = {
  'timeline-view.tsx': 'timeline',
  'list-view.tsx': 'list',
  'feed-view.tsx': 'feed',
  '../table-view/table-view.tsx': 'table',
};

describe('#964 Display writes every hidden_field_ids a renderer reads', () => {
  it('knows every renderer that reads hidden_field_ids', () => {
    const viewFiles = [
      'timeline-view.tsx',
      'list-view.tsx',
      'feed-view.tsx',
      'board-view.tsx',
      'gallery-view.tsx',
      'calendar-view.tsx',
    ];
    const readers = viewFiles.filter((f) => {
      try {
        return read(f).includes('hidden_field_ids');
      } catch {
        return false;
      }
    });
    for (const f of readers)
      expect(Object.keys(READERS), `${f} reads hidden_field_ids but is not in READERS`).toContain(
        f,
      );
  });

  it('offers the field list for the table and the timeline, INLINE (#1281 item 5: it replaced the "Fields…" button)', () => {
    const src = read('display-menu.tsx');
    expect(src).toMatch(/const hasFieldsMenu = isTable \|\| viewType === 'timeline';/);
    // the list is rendered in the popover, not just declared, and no second menu is opened from it
    expect(src).toMatch(/\{hasFieldsMenu && \(\s*<>\s*<span className=\{SECTION\}>Columns<\/span>\s*\{[^}]*\}\s*<FieldsList\s/);
    expect(src).not.toContain('<FieldsMenu');
    expect(src).not.toContain('Fields…');
  });

  it('lists the timeline REAL id field in its Fields, not the synthetic row-gutter key it never reads', () => {
    const src = read('display-menu.tsx');
    expect(src).toMatch(/fields\.find\(\(f\) => f\.type === 'id'\)/);
    // list and feed keep the gutter toggle (they render the synthetic number); the timeline does not get one.
    expect(src).toMatch(/viewType === 'list' \|\| viewType === 'feed' \? numberEntry : undefined/);
  });
});

/** #1281 item 4 — Row height is offered in words, while the stored value stays the pixel height the table measures with. */
describe('#1281 Row height labels', () => {
  it('Compact / Default / Tall map to 28 / 32 / 40', async () => {
    const { ROW_HEIGHT_OPTIONS } = await import('./display-menu');
    expect(ROW_HEIGHT_OPTIONS.map((o) => [o.label, o.value])).toEqual([
      ['Compact', '28'],
      ['Default', '32'],
      ['Tall', '40'],
    ]);
  });
  it('the menu still writes the numeric row_height and defaults to 32', () => {
    const src = read('display-menu.tsx');
    expect(src).toContain("String(config.row_height ?? 32)");
    expect(src).toContain('onPatch({ row_height: Number(v) as 28 | 32 | 40 })');
  });
});

/** #1281 — the inline list and Display's own rows are menu rows: they take the shared 28px / 12px geometry. */
describe('#1281 Display rows use the shared menu geometry', () => {
  it('the card-field rows and the field-list rows are 28px at 12px, not the old py-1.5 / 13px', () => {
    const d = read('display-menu.tsx');
    expect(d).toContain('MENU_ITEM_GEOMETRY');
    expect(d).not.toMatch(/rounded px-2 py-1\.5 text-body/);
    expect(read('fields-menu.tsx')).toContain('min-h-[var(--menu-item-height)]');
  });
  it('KEEPS the Display popover\'s own width, and the fields dropdown keeps its w-64', () => {
    expect(read('display-menu.tsx')).toContain('<PopoverContent className="max-h-[28rem] w-72 overflow-y-auto p-1">');
    expect(read('fields-menu.tsx')).toContain('<DropdownMenuContent align={align} className="w-64">');
  });
  it('reads "N of M" and offers Show all / Hide all through the shared list', () => {
    const f = read('fields-menu.tsx');
    expect(f).toContain('export function FieldsList');
    expect(f).toContain('of {bulk.total}');
    expect(f).toContain('Show all');
    expect(f).toContain('Hide all');
    // the other surfaces (record view, relation sub-table) pass no `bulk`, so they gain no row
    expect(read('../entity/record-chrome.tsx') + read('../entity/collection-section.tsx')).not.toContain('bulk=');
  });
});
