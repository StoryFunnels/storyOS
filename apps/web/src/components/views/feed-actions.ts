import type { Field } from '../table-view/use-table-data';

export interface FeedActionFields {
  /** Select-type "status" field for the inline status action, or undefined if the
   * database has no select field at all. */
  statusField?: Field;
  /** Checkbox field for the inline complete/uncomplete toggle, or undefined if the
   * database has none. */
  checkboxField?: Field;
  /** Single user-type field for the inline assign action, or undefined if the
   * database has none. */
  userField?: Field;
}

/**
 * Which quick-actions a feed card's footer shows (#76), derived purely from the
 * database's schema plus the view's own config — no fetching, so this is unit
 * testable without a React tree (MN-135 convention).
 *
 * Status/select follows the same convention board view uses to resolve its
 * group-by field (MN-079): prefer the view's already-configured select field
 * (feed reuses `color_by_field_id`, the MN-102 color-by field, as its "status"
 * field — the same one that tints the card's left border) and fall back to the
 * database's first select field. Checkbox/assign each need a field of that type
 * to exist at all; if the schema has none, that action is simply omitted rather
 * than showing placeholder UI.
 */
export function feedActionFields(
  fields: Field[],
  config: { color_by_field_id?: string },
): FeedActionFields {
  const configuredStatus = fields.find(
    (f) => f.id === config.color_by_field_id && f.type === 'select',
  );
  const statusField = configuredStatus ?? fields.find((f) => f.type === 'select');
  const checkboxField = fields.find((f) => f.type === 'checkbox');
  const userField = fields.find((f) => f.type === 'user');
  return { statusField, checkboxField, userField };
}
