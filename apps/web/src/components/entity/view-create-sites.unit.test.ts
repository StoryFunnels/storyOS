import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Ticket #1339 — a create that STARTS FROM A VIEW sends that view's id (`view_id`), so the server pre-fills what the view's
 * filter needs and says whether the record is in the view. A create that does NOT come from a view must not.
 *
 * The lists below are not the evidence on their own (a list is a proxy that drifts, CLAUDE.md rule 3): the sweep at the
 * bottom walks the whole source tree for anything that POSTs a record or uses the shared `createRecord`, and fails on a file
 * that is in NEITHER list, so a new create site has to be classified here.
 */
const SRC = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(SRC, p), 'utf8');

/** Create through the shared mutation, handing it the view being drawn. */
const VIA_HOOK: Array<[file: string, arg: string]> = [
  ['components/views/board-view.tsx', 'viewId'],
  ['components/views/list-view.tsx', 'viewId'],
  ['components/views/calendar-view.tsx', 'viewId'],
  ['components/views/gallery-view.tsx', 'viewId'],
  ['components/views/feed-view.tsx', 'viewId'],
  ['components/table-view/table-view.tsx', 'viewId'],
  ['app/w/[ws]/d/[db]/page.tsx', 'activeView\\?\\.id'],
];
/** Create with its own request, from the toolbar's New. */
const OWN_REQUEST_VIEW = ['components/record-templates/new-record-button.tsx'];

/** Not started from a view: no view_id, and no view-match toast. */
const NOT_FROM_A_VIEW = [
  'components/command-palette.tsx',
  'components/quick-add-fab.tsx',
  'components/table-view/relation-cell.tsx',
  'components/entity/collection-section.tsx',
  'components/runners/hire-dialog.tsx',
  'components/views/form-view.tsx', // a form submission, not a place records are drawn
];
/** The hook and the template path are classified separately (see the tests). */
const OTHER = ['components/table-view/use-table-data.ts', 'components/record-templates/record-templates.ts'];

describe('ticket #1339 — creates that start from a view send view_id', () => {
  for (const [file, arg] of VIA_HOOK) {
    it(`${file} gives the shared create the current view's id`, () => {
      expect(read(file)).toMatch(new RegExp(`useRecordMutations\\(ws, db, ${arg}\\)`));
    });
  }

  it('the shared create sends view_id only when a view id was given, and announces the verdict', () => {
    const src = read('components/table-view/use-table-data.ts');
    expect(src).toMatch(/\.\.\.\(viewId \? \{ view_id: viewId \} : \{\}\)/);
    expect(src).toMatch(/if \(viewId\) announceViewMatch\(/);
  });

  for (const file of OWN_REQUEST_VIEW) {
    it(`${file} sends view_id and announces the verdict before navigating`, () => {
      const src = read(file);
      expect(src).toMatch(/\.\.\.\(viewId \? \{ view_id: viewId \} : \{\}\)/);
      expect(src.indexOf('announceViewMatch(')).toBeGreaterThan(-1);
      expect(src.indexOf('announceViewMatch(')).toBeLessThan(src.indexOf('router.push(newRecordHref('));
    });
  }

  it('the toolbar passes its view id to New, and the page hands each view surface its id', () => {
    expect(read('components/views/view-toolbar.tsx')).toContain('<NewRecordButton ws={ws} db={db} viewId={viewId} />');
    const page = read('app/w/[ws]/d/[db]/page.tsx');
    for (const v of ['CalendarView', 'GalleryView', 'ListView', 'FeedView']) {
      expect(page).toContain(`<${v} ws={ws} db={db} viewId={activeView.id} `);
    }
  });

  for (const file of NOT_FROM_A_VIEW) {
    it(`${file} is not a view create: no view_id, no view-match toast`, () => {
      const src = read(file);
      expect(src).not.toContain('view_id');
      expect(src).not.toContain('announceViewMatch');
      // The shared create, where it is used at all, is called WITHOUT a view id.
      expect(src).not.toMatch(/useRecordMutations\(ws, db, /);
    });
  }

  it('sweep: every file that creates a record is classified above', () => {
    const known = new Set([...VIA_HOOK.map(([f]) => f), ...OWN_REQUEST_VIEW, ...NOT_FROM_A_VIEW, ...OTHER]);
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = resolve(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const src = readFileSync(p, 'utf8');
          const posts = /api\.POST\(\s*['"`][^'"`]*\/databases\/\{db\}\/records['"`]/.test(src);
          const viaShared = /createRecord\.mutate|\bcreateRecord\b.*useRecordMutations|useRecordMutations\([^)]*\)/.test(src) && /\bcreateRecord\b/.test(src);
          const template = /\{template\}\/records/.test(src);
          if (posts || viaShared || template) found.push(relative(SRC, p));
        }
      }
    };
    walk(SRC);
    const unclassified = found.filter((f) => !known.has(f));
    expect(unclassified, 'classify each new record-creating file in view-create-sites.unit.test.ts').toEqual([]);
  });
});
