import { describe, expect, it } from 'vitest';
import { landingRoute, manifestDefaultView, type LandingResult } from './pack-landing';

const WS = 'ws1';
const ok = (name: string, id: string, action: 'created' | 'reused' | 'skipped' = 'created') => ({ name, action, id });

// The shape of what the install returns for Team Board: databases by name, views by `Database.View` label.
const teamBoardResult: LandingResult = {
  databases: [ok('Projects', 'db-projects'), ok('Tasks', 'db-tasks')],
  views: [ok('Tasks.Board', 'v-board'), ok('Tasks.Assigned to me', 'v-mine'), ok('Projects.Active', 'v-active')],
};
const teamBoard = {
  views: [
    { database: 'Tasks', name: 'Board', default: true },
    { database: 'Tasks', name: 'Assigned to me' },
  ],
};

describe('manifestDefaultView', () => {
  it('is the view marked default', () => {
    expect(manifestDefaultView(teamBoard)).toEqual({ database: 'Tasks', name: 'Board' });
  });
  it('is null when the pack marks none, or has no views at all', () => {
    expect(manifestDefaultView({ views: [{ database: 'Tasks', name: 'Board' }] })).toBeNull();
    expect(manifestDefaultView({})).toBeNull();
    expect(manifestDefaultView(undefined)).toBeNull();
  });
  it('lets the LAST marked view win, as the server does for one database', () => {
    expect(
      manifestDefaultView({
        views: [
          { database: 'Tasks', name: 'Board', default: true },
          { database: 'Tasks', name: 'List', default: true },
        ],
      }),
    ).toEqual({ database: 'Tasks', name: 'List' });
  });
  it('ignores default: false', () => {
    expect(manifestDefaultView({ views: [{ database: 'Tasks', name: 'Board', default: false }] })).toBeNull();
  });
});

describe('landingRoute', () => {
  it('Team Board lands on its Board: the default view of Tasks, not the first view or the first database', () => {
    expect(landingRoute(WS, teamBoard, teamBoardResult)).toBe('/w/ws1/d/db-tasks?view=v-board');
  });

  it('Team Wiki lands on All pages and Dev Tracker on Active, whichever database they are in', () => {
    expect(
      landingRoute(
        WS,
        { views: [{ database: 'Pages', name: 'All pages', default: true }] },
        { databases: [ok('Pages', 'db-pages')], views: [ok('Pages.All pages', 'v-all')] },
      ),
    ).toBe('/w/ws1/d/db-pages?view=v-all');
    expect(
      landingRoute(
        WS,
        { views: [{ database: 'Issues', name: 'Active', default: true }, { database: 'Issues', name: 'Backlog' }] },
        { databases: [ok('Issues', 'db-issues')], views: [ok('Issues.Backlog', 'v-b'), ok('Issues.Active', 'v-a')] },
      ),
    ).toBe('/w/ws1/d/db-issues?view=v-a');
  });

  it('a pack with no default view has nowhere to land: the caller keeps the space page / result screen', () => {
    expect(landingRoute(WS, { views: [{ database: 'Tasks', name: 'Board' }] }, teamBoardResult)).toBeNull();
  });

  it('a failed or missing install result never navigates', () => {
    expect(landingRoute(WS, teamBoard, null)).toBeNull();
    expect(landingRoute(WS, teamBoard, undefined)).toBeNull();
  });

  it('a default view that was skipped, or whose database was, has no id to open', () => {
    // The server sends id '' for a skipped item; the action alone must also be enough, whatever id rides along.
    expect(landingRoute(WS, teamBoard, { ...teamBoardResult, views: [ok('Tasks.Board', '', 'skipped')] })).toBeNull();
    expect(landingRoute(WS, teamBoard, { ...teamBoardResult, databases: [ok('Tasks', '', 'skipped')] })).toBeNull();
    expect(landingRoute(WS, teamBoard, { ...teamBoardResult, views: [ok('Tasks.Board', 'v-board', 'skipped')] })).toBeNull();
    expect(landingRoute(WS, teamBoard, { ...teamBoardResult, databases: [ok('Tasks', 'db-tasks', 'skipped')] })).toBeNull();
  });

  it('a default view the install reused is still where to land (re-installing a pack)', () => {
    expect(
      landingRoute(WS, teamBoard, {
        databases: [ok('Tasks', 'db-tasks', 'reused')],
        views: [ok('Tasks.Board', 'v-board', 'reused')],
      }),
    ).toBe('/w/ws1/d/db-tasks?view=v-board');
  });

  it('a result that does not list the default view (nothing to match) does not navigate', () => {
    expect(landingRoute(WS, teamBoard, { databases: [ok('Tasks', 'db-tasks')], views: [ok('Tasks.Other', 'v-x')] })).toBeNull();
    expect(landingRoute(WS, teamBoard, { databases: [ok('Projects', 'db-projects')], views: [ok('Tasks.Board', 'v-board')] })).toBeNull();
  });

  it('matches names the way the server does: case and surrounding space do not matter', () => {
    expect(
      landingRoute(WS, teamBoard, { databases: [ok('tasks ', 'db-tasks')], views: [ok(' tasks.board', 'v-board')] }),
    ).toBe('/w/ws1/d/db-tasks?view=v-board');
  });
});
