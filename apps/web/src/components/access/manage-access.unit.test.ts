import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AccessMain, OpenStep, RestrictStep } from './manage-access';
import type { DatabaseTarget, Grant, GrantRole, Person, SpaceTarget, Target } from '@/lib/access-model';

const person = (userId: string, workspaceRole: Person['workspaceRole']): Person => ({ userId, name: userId, workspaceRole });
const people = [person('Ada', 'admin'), person('Otto', 'member'), person('Mira', 'member'), person('Iris', 'member'), person('Lena', 'guest'), person('Gus', 'guest')];
let n = 0;
const onSpace = (userId: string, role: GrantRole): Grant => ({ id: `g${++n}`, userId, role, spaceId: 's1', databaseId: null });
const onDb = (userId: string, role: GrantRole): Grant => ({ id: `g${++n}`, userId, role, spaceId: null, databaseId: 'd1' });

const space = (restricted: boolean): SpaceTarget => ({ kind: 'space', id: 's1', name: 'Client Work', restricted });
const database = (over: Partial<DatabaseTarget> = {}, spaceRestricted = false): DatabaseTarget => ({
  kind: 'database', id: 'd1', name: 'Clients', restricted: false, isSystem: false,
  space: { id: 's1', name: 'Client Work', restricted: spaceRestricted }, ...over,
});

const noop = () => {};
const main = (target: Target, grants: Grant[] = []) =>
  renderToStaticMarkup(createElement(AccessMain, { target, people, grants, onPickCard: noop, onRole: noop, onRemove: noop, onAdd: noop, onOpenSpace: noop }));
const restrict = (target: Target, grants: Grant[] = [], keep: string[] = []) =>
  renderToStaticMarkup(createElement(RestrictStep, { target, people, grants, keep: new Set(keep), onToggle: noop, busy: false, onCancel: noop, onConfirm: noop }));
const open = (target: Target, grants: Grant[] = [], closed: string[] = []) =>
  renderToStaticMarkup(createElement(OpenStep, { target, people, grants, restrictedDatabaseNames: closed, busy: false, onCancel: noop, onConfirm: noop }));

describe('the Manage access states (#924)', () => {
  it('EVERYONE: a summary row with the counts, the Creator word, the guest add box, and the Everyone card selected', () => {
    const out = main(space(false), [onSpace('Lena', 'viewer')]);
    expect(out).toContain('Everyone in the workspace');
    expect(out).toContain('1 admin, 3 members');
    expect(out).toContain('>Creator<');
    expect(out).toContain('Add a guest…');
    expect(out).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>(<span[^>]*>)?[^<]*Everyone in the workspace/);
    expect(out).toContain('Lena');
    expect(out).not.toContain('People without access don');
  });

  it('EVERYONE: members holding a grant get the note that they keep access if it is restricted', () => {
    expect(main(space(false), [onSpace('Otto', 'viewer')])).toContain('Otto holds a grant here and keeps access if this is restricted.');
  });

  it('RESTRICTED: admins first as "Always has access", every holder a row with a role button, the footer about being invisible', () => {
    const out = main(space(true), [onSpace('Otto', 'editor'), onSpace('Lena', 'viewer')]);
    expect(out).toContain('People with access · 3');
    expect(out).toContain('Always has access');
    expect(out).toContain('aria-label="Role of Otto on Client Work: Editor"');
    expect(out).toContain('aria-label="Role of Lena on Client Work: Viewer"');
    expect(out).toContain('Add people…');
    expect(out).toContain('People without access don’t see “Client Work” anywhere');
    expect(out).toContain('Restricted');
  });

  it('RESTRICTED with only admins: the empty box says so', () => {
    expect(main(space(true))).toContain('Only admins can see “Client Work” right now.');
  });

  it('INHERITED: the space\'s people are read-only with a link to the space, "added here" is editable, and the higher role is explained', () => {
    const out = main(database({}, true), [onSpace('Otto', 'viewer'), onSpace('Mira', 'editor'), onDb('Mira', 'viewer')]);
    expect(out).toContain('From Client Work · 1');
    expect(out).toContain('Manage Client Work’s access →');
    expect(out).toContain('Added here · 1');
    expect(out).toContain('Editor from Client Work, the higher role wins');
    expect(out).toContain('Everyone in Client Work');
    expect(out).not.toContain('aria-label="Role of Otto'); // Otto's role is shown, not editable here
  });

  it('STICKY: a restricted database in a restricted space names the space people who do not see it', () => {
    const out = main(database({ restricted: true }, true), [onSpace('Mira', 'editor'), onSpace('Lena', 'viewer')]);
    expect(out).toContain('Lena and Mira have access to Client Work but do not see this database.');
    expect(out).toContain('role="note"');
  });

  it('SYSTEM: no cards, one note, nothing to change (decided by the flag)', () => {
    const out = main(database({ isSystem: true }));
    expect(out).toContain('is a system database: it cannot be restricted');
    expect(out).not.toContain('role="radio"');
    expect(out).not.toContain('Add people');
  });

  it('the add box never offers an admin or someone already added', () => {
    const out = main(space(true), [onSpace('Otto', 'viewer')]);
    expect(out).toContain('Add people…');
    // the search list is closed until focus (the population itself is the model's tests)
    expect(out).not.toContain('max-h-48');
  });
});

describe('the Restrict confirm (#924)', () => {
  it('says how many lose access, lists them with a Keep tick each, and the red button counts who is removed', () => {
    const out = restrict(space(false), [onSpace('Lena', 'viewer')]);
    expect(out).toContain('3 people can see it now and won&#x27;t once it&#x27;s restricted. Tick anyone who should keep access.');
    expect(out).toContain('Keep as Editor');
    expect(out).toContain('Restrict — remove 3 people');
    expect(out).toContain('Admins always keep access.');
    expect(out).toMatch(/<button[^>]*border-error[^>]*>Restrict — remove 3 people/);
  });

  it('ticking people lowers the count; ticking everyone turns it into a plain primary "Restrict"', () => {
    expect(restrict(space(false), [], ['Otto'])).toContain('Restrict — remove 2 people');
    const all = restrict(space(false), [], ['Otto', 'Mira', 'Iris']);
    expect(all).toMatch(/>Restrict<\/button>/);
    expect(all).not.toMatch(/border-error[^>]*>Restrict/);
  });

  it('when nobody loses access it says so and offers a plain Restrict', () => {
    const out = restrict(database({}, true));
    expect(out).toContain('Nobody but admins can see “Clients” today, so nobody loses access.');
    expect(out).toMatch(/>Restrict<\/button>/);
  });

  it('people who already hold a grant here are named as keeping it', () => {
    expect(restrict(space(false), [onSpace('Otto', 'viewer')])).toContain('Otto already has access and keeps it.');
  });

  it('a guest whose only access was the space grant is listed "through the space", keeping their role', () => {
    const out = restrict(database(), [onSpace('Lena', 'commenter')]);
    expect(out).toContain('Guest · through the space');
    expect(out).toContain('Keep as Commenter');
  });
});

describe('the open-to-everyone confirm (#924)', () => {
  it('names the role widening with what each person is today, and that grants are kept', () => {
    const out = open(space(true), [onSpace('Otto', 'editor'), onSpace('Mira', 'viewer')]);
    expect(out).toContain('All 3 members will see it as creators');
    expect(out).toContain('Iris for the first time');
    expect(out).toContain('That includes Mira (Viewer here today) and Otto (Editor here today).');
    expect(out).toContain('The people added here stay on the list');
    expect(out).not.toMatch(/border-error/);
  });

  it('a space names its own restricted databases that stay closed', () => {
    expect(open(space(true), [], ['Contacts'])).toContain('Its restricted database (Contacts) stays closed.');
    expect(open(space(true), [], ['Contacts', 'Payroll'])).toContain('Its restricted databases (Contacts and Payroll) stay closed.');
  });

  it('a database falling back to its restricted space is not a workspace-wide widening', () => {
    const out = open(database({ restricted: true }, true), [onSpace('Mira', 'viewer')]);
    expect(out).toContain('Everyone who can open Client Work will see “Clients”');
    expect(out).toContain('Mira for the first time');
    expect(out).not.toContain('as creators');
  });
});

describe('the entry points ask one predicate (#924)', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '../../', rel), 'utf8');
  it('the sidebar and the space page gate Manage access with canManageAccess, not an inline admin check', () => {
    const sidebar = read('components/sidebar.tsx');
    expect(sidebar).toMatch(/canManageAccess\(isAdmin \? 'admin' : undefined\)/g);
    expect(sidebar).not.toMatch(/isAdmin &&\s*\(\s*<DropdownMenuItem onSelect=\{\(\) => setSharing/);
    expect(read('app/w/[ws]/s/[space]/page.tsx')).toContain('canManageAccess(workspace.data?.role)');
  });

  // Found live: with a Dialog open the toast's Undo never received a click (body pointer-events none), and the role menu,
  // a plain popover in a modal dialog, never did either. Both are interactive layers over a modal.
  it('toasts stay clickable over a modal dialog, and the role menu is a modal popover', () => {
    expect(read('components/ui/toaster.tsx')).toMatch(/pointerEvents: 'auto'/);
    expect(read('components/access/role-menu.tsx')).toMatch(/<Popover modal /);
    expect(read('components/ui/dialog.tsx')).toContain("closest?.('[data-sonner-toast]')");
  });

  it('the old guests-only dialog is gone', () => {
    expect(() => read('components/share-dialog.tsx')).toThrow();
  });
});
