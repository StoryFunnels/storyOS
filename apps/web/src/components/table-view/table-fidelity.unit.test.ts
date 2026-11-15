import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const code = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

describe('table header and ID column fidelity (#1275 items 2 and 3)', () => {
  const header = code('components/table-view/header-cell.tsx');
  it('the header cell is 36px, 11px/600 (it was h-8, 12px/500)', () => {
    expect(header).toMatch(/group\/header relative flex h-9 shrink-0[^']*text-meta font-semibold text-muted/);
    expect(header).not.toMatch(/group\/header relative flex h-8/);
  });
  it('the "New field" tail cell matches the header row', () => {
    expect(code('components/table-view/table-view.tsx')).toMatch(/h-9 w-\[110px\][^"]*text-meta font-semibold/);
  });
  it('the record-number column is labelled "ID", not "#", and keeps its full name on hover', () => {
    expect(header).toMatch(/field\.type === 'id' \? 'ID' : field\.displayName/);
    expect(header).toMatch(/title=\{field\.type === 'id' \? field\.displayName : undefined\}/);
  });
  it('KEEPS other columns labelled by their own name, truncating', () => {
    expect(header).toMatch(/className="truncate"/);
  });
  it('the ID cell is the 10px faint figure; the column is still wide enough for ID + mark + ⋯', () => {
    expect(code('components/table-view/cells.tsx')).toContain('truncate text-micro tabular-nums text-faint">{String(value)}');
    expect(readFileSync(join(__dirname, 'table-view.tsx'), 'utf8')).toMatch(/ID_COLUMN_WIDTH = 7\d/);
  });
  it('the list and the feed write the same bare number, no "#", via the one shared badge', () => {
    const board = code('components/views/board-view.tsx');
    const badge = board.slice(board.indexOf('export function RecordNumberBadge'));
    expect(badge).toContain('text-micro text-faint');
    expect(badge.slice(0, badge.indexOf('\n}\n'))).not.toContain('#{number}');
    for (const rel of ['components/views/list-view.tsx', 'components/views/feed-view.tsx']) {
      expect(code(rel)).toContain('<RecordNumberBadge');
      expect(code(rel)).not.toMatch(/#\{row\.number\}/);
    }
  });
  it('row height is NOT changed here: 28/32/40 is the schema and the Display menu (deferred, needs a 34 option)', () => {
    expect(code('components/table-view/table-view.tsx')).toContain('config?.row_height ?? 32');
  });
});
