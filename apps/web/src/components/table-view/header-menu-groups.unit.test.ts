import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { headerMenuSeparators } from './header-menu-groups';

const all = { edit: true, filterSort: true, visibility: true, destructive: true };
const none = { edit: false, filterSort: false, visibility: false, destructive: false };

describe('#1281 header menu separators', () => {
  it('a full menu has a rule between each of its four groups', () => {
    expect(headerMenuSeparators(all)).toEqual({ afterEdit: true, afterFilterSort: true, afterVisibility: true });
  });
  it('never opens or ends on a rule, and never doubles one (what must be KEPT: no stray separator)', () => {
    expect(headerMenuSeparators(none)).toEqual({ afterEdit: false, afterFilterSort: false, afterVisibility: false });
    // a viewer: filter/sort + hide only
    expect(headerMenuSeparators({ ...none, filterSort: true, visibility: true })).toEqual({
      afterEdit: false,
      afterFilterSort: true,
      afterVisibility: false,
    });
    // the title column of a manager: edit, filter/sort and freeze, but Hide is withheld and so is Delete
    expect(headerMenuSeparators({ edit: true, filterSort: true, visibility: true, destructive: false })).toEqual({
      afterEdit: true,
      afterFilterSort: true,
      afterVisibility: false,
    });
  });
  it('skips an empty middle group instead of leaving two rules in a row', () => {
    expect(headerMenuSeparators({ edit: true, filterSort: false, visibility: false, destructive: true })).toEqual({
      afterEdit: true,
      afterFilterSort: false,
      afterVisibility: false,
    });
  });
});

describe('#1281 header menu wiring', () => {
  const src = readFileSync(join(__dirname, 'header-cell.tsx'), 'utf8');
  it('renders a separator for each flag and an icon on every item', () => {
    for (const f of ['afterEdit', 'afterFilterSort', 'afterVisibility']) expect(src).toContain(`menuSeparators.${f} && <DropdownMenuSeparator />`);
    for (const icon of ['Pencil', 'ArrowLeftRight', 'Link2', 'Trash2', 'ListFilter', 'ArrowUpDown', 'Snowflake', 'EyeOff']) {
      expect(src, icon).toContain(`<${icon} className="mr-2 h-3.5 w-3.5" />`);
    }
  });
});
