/**
 * #1116 — the part of a collection view that shapes its records QUERY. Colour-by only paints rows,
 * so it stays out: two colour choices make one query key, and switching colour never refetches.
 */
export function collectionQueryView<T extends { color_by?: string | null }>(cv: T): Omit<T, 'color_by'> & { color_by: undefined } {
  return { ...cv, color_by: undefined };
}
