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

  it('offers Fields… for the table and the timeline', () => {
    const src = read('display-menu.tsx');
    expect(src).toMatch(/const hasFieldsMenu = isTable \|\| viewType === 'timeline';/);
    // the picker is rendered, not just declared
    expect(src).toMatch(/\{hasFieldsMenu && \(\s*<FieldsMenu/);
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
