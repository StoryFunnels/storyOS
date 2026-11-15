import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EmptyState } from '@/components/ui/empty-state';
import { PublicViewClient } from '@/app/v/[token]/public-view-client';
import type { PublicViewDef } from '@/app/v/[token]/public-view-client';

/**
 * Ticket #1291, last PR: the empty sentences that used to be parked in the guard's DEFERRED list now render through <EmptyState>.
 *
 * The public view page renders for real (no hooks). The others sit inside hook-driven components (queries, the palette's store),
 * so for them this pins two facts: the surface hands its sentence to `<EmptyState variant="list" title=…>`, and that component
 * draws exactly that sentence as a status line. The browser click-through is in the PR.
 */
const SRC = join(__dirname, '..', '..');
const SURFACES: { file: string; copy: string }[] = [
  { file: 'components/command-palette.tsx', copy: 'No matches for' },
  { file: 'components/command-palette.tsx', copy: 'Type to search.' },
  { file: 'components/workspace-home-blocks.tsx', copy: 'No automation runs yet.' },
  { file: 'components/workspace-home-blocks.tsx', copy: 'Nothing is waiting on a person.' },
  { file: 'components/entity/record-chrome.tsx', copy: 'No enabled agents yet — create one in the Agents database, or enable an existing one.' },
  { file: 'components/automations/run-agent-editor.tsx', copy: 'No agents are set up in this workspace yet, so there is nothing to run. Set one up first.' },
  { file: 'app/w/[ws]/settings/integrations/google-calendar/page.tsx', copy: 'No mappings yet. Complete the fields above; dated records will become Google events after the first sync.' },
  { file: 'components/views/form-view.tsx', copy: 'No fields yet — add one below.' },
];

describe('the last hand-rolled empties render through <EmptyState> (ticket #1291)', () => {
  it('the public view page draws its empty table through the shared list state', () => {
    const def: PublicViewDef = {
      view: { id: 'v1', name: 'My View', type: 'table' },
      database: { name: 'My Database' },
      fields: [],
      indexable: false,
      hide_branding: false,
      branding: { logo_url: null, accent_color: null },
      records: { data: [], next_cursor: null, has_more: false },
    };
    const html = renderToStaticMarkup(createElement(PublicViewClient, { token: 't1', initialDef: def, embed: false }));
    expect(html).toContain('data-empty-state="list"');
    expect(html).toContain('Nothing here yet.');
  });

  for (const { file, copy } of SURFACES) {
    it(`${file}: "${copy.slice(0, 40)}" is the title of an <EmptyState variant="list">`, () => {
      const src = readFileSync(join(SRC, file), 'utf8');
      const at = src.indexOf(copy);
      expect(at, 'the copy is still on the surface').toBeGreaterThan(-1);
      const open = src.lastIndexOf('<EmptyState', at);
      expect(open, 'inside an <EmptyState>').toBeGreaterThan(-1);
      const tag = src.slice(open, at);
      expect(tag).toContain('variant="list"');
      expect(tag).not.toContain('/>');
      const html = renderToStaticMarkup(createElement(EmptyState, { variant: 'list', title: copy }));
      expect(html).toContain('role="status"');
      expect(html).toContain(copy);
    });
  }
});
