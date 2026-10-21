import { describe, expect, it } from 'vitest';
import { buildViewMenu, type ViewMenuHandlers } from './view-menu';

const t = { name: 'Board', isDefault: false, personal: false };
const noop = () => undefined;
const full: ViewMenuHandlers = {
  canManage: true,
  canDelete: true,
  onRename: noop,
  onDuplicate: noop,
  onSetDefault: noop,
  onCopyLink: noop,
  onShare: noop,
  onCopyToPersonal: noop,
  moves: [{ id: 'f1', label: 'Move to Marketing', onSelect: noop }],
  onDelete: noop,
};
const ids = (items: ReturnType<typeof buildViewMenu>) => items.map((i) => i.id);

describe('buildViewMenu (#964)', () => {
  it('lists the items in the ticket\'s order', () => {
    expect(ids(buildViewMenu(t, full))).toEqual(['rename', 'duplicate', 'default', 'link', 'share', 'personal', 'move:f1', 'delete']);
  });

  it('the toolbar door ADDS widget and CSV, between Move and Delete, and nothing else differs', () => {
    const toolbar = ids(buildViewMenu(t, { ...full, onAddWidget: noop, exportHref: '/x.csv' }));
    expect(toolbar).toEqual(['rename', 'duplicate', 'default', 'link', 'share', 'personal', 'move:f1', 'widget', 'csv', 'delete']);
    expect(toolbar.filter((i) => i !== 'widget' && i !== 'csv')).toEqual(ids(buildViewMenu(t, full)));
  });

  it('the default view has no "Set as default"', () => {
    expect(ids(buildViewMenu({ ...t, isDefault: true }, full))).not.toContain('default');
  });

  it('a PERSONAL view is never shared and never copied to My Space', () => {
    const out = ids(buildViewMenu({ ...t, personal: true }, full));
    expect(out).not.toContain('share');
    expect(out).not.toContain('personal');
    expect(out).toContain('rename');
  });

  it('Delete is shown but inert, with a reason, when it is the only view', () => {
    const del = buildViewMenu(t, { ...full, canDelete: false }).find((i) => i.id === 'delete');
    expect(del?.disabledReason).toMatch(/at least one view/);
  });

  it('a viewer who cannot manage gets only Copy link (and a CSV if the door offers it)', () => {
    expect(ids(buildViewMenu(t, { ...full, canManage: false }))).toEqual(['link']);
    expect(ids(buildViewMenu(t, { ...full, canManage: false, exportHref: '/x.csv' }))).toEqual(['link', 'csv']);
  });

  it('a door that cannot run an item does not list it', () => {
    expect(ids(buildViewMenu(t, { canManage: true, canDelete: true, onRename: noop, onDelete: noop }))).toEqual(['rename', 'delete']);
  });

  it('has no "Save as new view" and no "Pin to tabs" (views auto-save; pinned tabs wait on #966)', () => {
    const labels = buildViewMenu(t, { ...full, onAddWidget: noop, exportHref: '/x' }).map((i) => i.label.toLowerCase());
    expect(labels.some((l) => l.includes('save as'))).toBe(false);
    expect(labels.some((l) => l.includes('pin'))).toBe(false);
  });
});
