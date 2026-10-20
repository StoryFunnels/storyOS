/**
 * #963 — the order of a choice field's options IS its sort order and its board's "Field order"
 * (Marek's #961: the query ranks select, multi-select and workflow values by option position). These
 * are the two pure rules the web half needs, kept out of the components so they can be tested.
 */

/**
 * Positions to write after dragging option `from` to slot `to`: a clean 0..n-1 sequence, only for the
 * options whose slot actually changed. The API takes ONE option's position per call and shifts no
 * siblings, so every moved option has to be written; writing a clean sequence also repairs a field
 * whose positions had gaps or ties.
 */
export function reorderPositions(ids: readonly string[], from: number, to: number): Array<{ id: string; position: number }> {
  if (from < 0 || to < 0 || from >= ids.length || to >= ids.length || from === to) return [];
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  const out: Array<{ id: string; position: number }> = [];
  next.forEach((id, position) => {
    if (id !== ids[position]) out.push({ id, position });
  });
  return out;
}

/**
 * The sort-direction labels for a choice field: "<first option> → <last option>" and the reverse,
 * read from the REAL options in position order ("Low → Urgent"). Null with fewer than two options,
 * where there is no order to name.
 */
export function choiceDirectionLabels(options: ReadonlyArray<{ label: string }>): { asc: string; desc: string } | null {
  if (options.length < 2) return null;
  const first = options[0]!.label;
  const last = options[options.length - 1]!.label;
  return { asc: `${first} → ${last}`, desc: `${last} → ${first}` };
}
