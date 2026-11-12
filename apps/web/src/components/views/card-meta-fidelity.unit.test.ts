import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const code = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

describe('card meta row (#1275 item 4)', () => {
  const board = code('components/views/board-view.tsx');
  const chip = board.slice(board.indexOf('export function CardFieldChip'));
  it('a person on a card is the 18px shared avatar, not the full-name pill', () => {
    expect(chip).toMatch(/field\.type === 'user' && surface === 'card'[\s\S]*?size=\{18\}/);
  });
  it('a date on a card is the compact (10px muted) CellDisplay date with a glyph', () => {
    expect(chip).toMatch(/field\.type === 'date' && surface === 'card'[\s\S]*?CalendarDays[\s\S]*?compact/);
    expect(code('components/table-view/cells.tsx')).toContain('truncate text-micro tabular-nums text-muted');
  });
  it('only the board/gallery card asks for the card surface', () => {
    expect(board).toMatch(/surface="card"/);
    expect(code('components/views/list-view.tsx')).not.toMatch(/surface=/);
    expect(code('components/views/feed-view.tsx')).not.toMatch(/surface=/);
  });
  it('KEEPS the name pill (list, feed) and the body-size date (table, record page, list) as they were', () => {
    expect(chip).toMatch(/rounded-full bg-hover px-1\.5 py-0\.5 text-meta text-ink-secondary[\s\S]{0,260}memberNames\.get\(id\) \?\? '—'/);
    expect(code('components/table-view/cells.tsx')).toContain('truncate text-body tabular-nums text-ink-secondary">{shown}');
  });
  it('the Avatar carries the full name for hover', () => {
    expect(readFileSync(join(__dirname, '..', 'ui', 'avatar.tsx'), 'utf8')).toMatch(/title=\{name\}/);
  });
});
