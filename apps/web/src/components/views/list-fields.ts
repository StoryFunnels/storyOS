import type { Field } from '../table-view/use-table-data';

/**
 * #1115 — how a list row lays its card fields out. Short categorical values (a select, a
 * workflow) and ONE identifying text (the first text field in the card order — an SF-123) lead
 * the title, the way a tracker's row reads; everything else — sets, people, figures, dates,
 * further text — follows it in fixed slots. The row's own state field is in neither: its glyph
 * stands before the title.
 */
export function splitCardFields(cardFields: Field[], stateFieldId: string | undefined): { leading: Field[]; trailing: Field[] } {
  const firstText = cardFields.find((f) => f.type === 'text');
  const leading = cardFields.filter((f) => f.id !== stateFieldId && ((f.type === 'select' || f.type === 'workflow') || f === firstText));
  const trailing = cardFields.filter((f) => f.id !== stateFieldId && !leading.includes(f));
  return { leading, trailing };
}
