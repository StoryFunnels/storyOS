import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { registerToolbarNew, toolbarLacksNew, useReportToolbarNew } from './toolbar-new-signal';

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/**
 * Ticket #1275 item 10 — the corner "+" is hidden only where the toolbar already has a New. The decision of whether a toolbar
 * has one lives in view-toolbar.tsx; the layout must read THAT, not infer it from the URL.
 */
describe('the floating + follows the toolbar, not the URL (ticket #1275 item 10)', () => {
  it('nothing mounted yet means "not lacking": the + stays hidden while a view loads (no flash)', () => {
    expect(toolbarLacksNew()).toBe(false);
  });

  it('a toolbar WITHOUT New on screen means the + is offered; a toolbar WITH New turns it off again', () => {
    const dashboard = registerToolbarNew(false);
    expect(toolbarLacksNew()).toBe(true);
    const table = registerToolbarNew(true); // e.g. a record panel beside it carrying a table that has its own New
    expect(toolbarLacksNew()).toBe(false);
    table();
    expect(toolbarLacksNew()).toBe(true);
    dashboard();
    expect(toolbarLacksNew()).toBe(false); // back to "nothing mounted": hidden, no stuck state after navigating away
  });

  it('KEEPS the + hidden for a table view (a toolbar with New) on its own', () => {
    const table = registerToolbarNew(true);
    expect(toolbarLacksNew()).toBe(false);
    table();
  });

  it('the hook is effect-based, so a server render registers nothing (the + cannot be shown by a render that never mounts)', () => {
    function Probe({ hasNew }: { hasNew: boolean }) {
      useReportToolbarNew(hasNew);
      return null;
    }
    renderToString(createElement(Probe, { hasNew: false }));
    expect(toolbarLacksNew()).toBe(false);
  });

  it('the toolbar reports the SAME condition it draws New under: no New for a dashboard view or a read-only viewer', () => {
    const t = src('components/views/view-toolbar.tsx');
    expect(t).toMatch(/const drawsNew = Boolean\(ws && db && !readOnly && viewType !== 'dashboard'\)/);
    expect(t).toContain('useReportToolbarNew(drawsNew)');
    expect(t).toMatch(/\{drawsNew && ws && db && <NewRecordButton/);
  });

  it('the workspace layout passes the signal to the visibility rule', () => {
    const l = src('app/w/[ws]/layout.tsx');
    expect(l).toContain('const toolbarLacksNew = useToolbarLacksNew()');
    expect(l).toContain('showQuickAddFab(pathname, toolbarLacksNew)');
  });
});
