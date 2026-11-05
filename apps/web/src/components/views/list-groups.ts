/**
 * The groups (section headings) of a grouped LIST, as a pure function so every rule is testable.
 *
 * Two kinds of grouping field, matching `canGroupListBy` (groupable-fields.ts):
 *
 * - select / workflow: one group per OPTION, in option order, each carrying the option's colour and
 *   state category (unchanged from before ticket #1147; it only moved here).
 * - relation (the single side of a one-to-many, ticket #1147): one group per RELATED RECORD, headed by
 *   its title. The related records come from `targets` (the target database's records, in the API's
 *   order) UNIONED with every chip actually found on the loaded rows. The union matters: `targets` is
 *   one page, so in a workspace with more teams than that page a row's team would otherwise match no
 *   group and silently fall under "No Team" - a confident wrong heading.
 *
 * A row with no value, or whose chip matches nothing, goes to the no-value group, labelled
 * `No <field name>` for a relation and `No value` for a select.
 *
 * What the server does for several links: `boardGroupError` refuses a many-to-many relation (and the
 * "many" side) for boards, and `canGroupListBy` mirrors that, so a multi-link field is never offered. If
 * a saved config nevertheless points a list at one, `canGroupListBy` is false and the list draws ungrouped
 * rather than putting a row under two headings. Should a single-sided relation ever carry two chips, the
 * row sits under the FIRST, the same choice the board makes.
 */

export const NO_VALUE = '__none__';

export interface ListGroupField {
  type: string;
  apiName: string;
  displayName: string;
  options?: Array<{ id: string; label: string; color: string; category?: string | null }> | null;
}

export interface ListGroupRow {
  values: Record<string, unknown>;
}

export interface RelationTarget {
  id: string;
  title: string;
}

export interface ListGroupDef<R> {
  id: string;
  label: string;
  color: string;
  category: string | null;
  rows: R[];
}

type Chip = { id: string; title?: string | null };

/** The first related record a row links to through `apiName`, or null. */
export function firstChip(row: ListGroupRow, apiName: string): Chip | null {
  const raw = row.values[apiName];
  if (!Array.isArray(raw)) return null;
  const first = raw[0] as Chip | undefined;
  return first && typeof first.id === 'string' ? first : null;
}

export function buildListGroups<R extends ListGroupRow>(opts: {
  field: ListGroupField;
  rows: readonly R[];
  /** The related database's records, for a relation field; ignored otherwise. */
  targets?: readonly RelationTarget[];
  /** Colour for a group that has no colour of its own (relation targets, the no-value group). */
  neutralColor: string;
  /** Maps an option's colour name to a drawn colour (select / workflow). */
  optionColor: (name: string) => string;
}): Array<ListGroupDef<R>> {
  const { field, rows, targets, neutralColor, optionColor } = opts;

  if (field.type === 'relation') {
    const defs = new Map<string, { label: string }>();
    for (const t of targets ?? []) defs.set(t.id, { label: t.title || 'Untitled' });
    for (const row of rows) {
      const chip = firstChip(row, field.apiName);
      if (chip &&!defs.has(chip.id)) defs.set(chip.id, { label: chip.title || 'Untitled' });
    }
    const buckets = new Map<string, R[]>([...defs.keys()].map((id) => [id, []]));
    const none: R[] = [];
    for (const row of rows) {
      const chip = firstChip(row, field.apiName);
      (chip ? buckets.get(chip.id)! : none).push(row);
    }
    return [
      ...[...defs].map(([id, d]) => ({ id, label: d.label, color: neutralColor, category: null, rows: buckets.get(id)! })),
      { id: NO_VALUE, label: `No ${field.displayName}`, color: neutralColor, category: null, rows: none },
    ];
  }

  const options = field.options ?? [];
  const buckets = new Map<string, R[]>(options.map((o) => [o.id, []]));
  buckets.set(NO_VALUE, []);
  for (const row of rows) {
    const v = (row.values[field.apiName] as string | undefined) ?? NO_VALUE;
    (buckets.get(v) ?? buckets.get(NO_VALUE)!).push(row);
  }
  return [
    ...options.map((o) => ({
      id: o.id,
      label: o.label,
      color: optionColor(o.color),
      category: o.category ?? null,
      rows: buckets.get(o.id)!,
    })),
    { id: NO_VALUE, label: 'No value', color: neutralColor, category: null, rows: buckets.get(NO_VALUE)! },
  ];
}
