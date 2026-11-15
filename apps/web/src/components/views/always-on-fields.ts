/**
 * #1281 item 3 — the title column is always on. The header menu offered "Hide field" on it while the toolbar's Fields
 * panel (NON_TOGGLABLE) never listed it, so a person could hide the title from its own header and then find no control that
 * brings it back. The prototype's Display panel marks Name "always on" and its header menu has no Hide for it.
 *
 * One predicate for both ends, so the menu's offer and the renderer's behaviour cannot drift: the header menu hides the item,
 * and the table ignores a stale `hidden_field_ids` entry for it (views saved before this change may already carry one).
 */
export function isAlwaysOnField(field: { type: string }): boolean {
  return field.type === 'title';
}
