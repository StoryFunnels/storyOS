import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MyWorkPreview, MyWorkRowButton } from './my-work-rows';
import { buildRows, databaseLabels, type MyWorkGroup } from './my-work-model';

const NOW = new Date('2026-11-12T10:00:00');
const fmtDate = (iso: string) => `D:${iso}`;

const GROUPS: MyWorkGroup[] = [
  {
    database: { id: 'team', name: 'Tasks', icon: null, color: null },
    fields: [],
    records: [{ id: 'a', title: 'Alpha', number: 4, updated_at: '2026-11-01T00:00:00Z', values: {} }],
  },
  {
    database: { id: 'client', name: 'Tasks', icon: null, color: null },
    fields: [],
    records: [{ id: 'b', title: 'Beta', number: 4, updated_at: '2026-11-01T00:00:00Z', values: {} }],
  },
  {
    database: { id: 'issues', name: 'Issues', icon: null, color: null },
    fields: [],
    records: [{ id: 'c', title: 'Gamma', number: 9, updated_at: '2026-11-01T00:00:00Z', values: {} }],
  },
];
const SPACES: Record<string, string> = { team: 'Team', client: 'Client Work', issues: 'Team' };

function rowHtml(rowIndex: number, labels: Map<string, string>) {
  const row = buildRows(GROUPS, {}, labels)[rowIndex]!;
  return renderToStaticMarkup(createElement(MyWorkRowButton, { row, selected: false, onSelect: () => {}, fmtDate, now: NOW }));
}

describe('rows name their database when the name is shared (ticket #1280 item 2)', () => {
  const labels = databaseLabels(GROUPS.map((g) => g.database), (id) => SPACES[id]);
  it('two same-named databases read "Space / Name" on their rows, so "#4 · Tasks" twice cannot happen', () => {
    expect(rowHtml(0, labels)).toContain('#4 · Team / Tasks');
    expect(rowHtml(1, labels)).toContain('#4 · Client Work / Tasks');
  });
  it('KEEPS the short form for a name that is unique', () => {
    expect(rowHtml(2, labels)).toContain('#9 · Issues');
    expect(rowHtml(2, labels)).not.toContain('Team / Issues');
  });
  it('the preview header names it the same way', () => {
    const row = buildRows(GROUPS, {}, labels)[1]!;
    const html = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(MyWorkPreview, {
        ws: 'w', row, tab: 'assigned', onBack: () => {}, fmtDate, now: NOW, memberNames: new Map(), memberImages: new Map(),
      })),
    );
    expect(html).toContain('Client Work / Tasks');
  });
});

