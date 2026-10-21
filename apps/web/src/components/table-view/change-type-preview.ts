/**
 * #958 — the words of the Change type dialog's "Check impact" for a text → choice conversion (#957). Pure, so the
 * plurals and the all-empty case are tested rather than eyeballed.
 */
export interface ChoicePreview {
  options: Array<{ label: string; color: string; records: number }>;
  empty_records?: number;
}

export function choicePreviewHeading(p: ChoicePreview): string {
  const n = p.options.length;
  const empty = p.empty_records ?? 0;
  if (n === 0) {
    return empty > 0
      ? `No options to create: all ${empty} record${empty === 1 ? ' is' : 's are'} empty`
      : 'No options to create: there are no records';
  }
  const created = `${n} option${n === 1 ? '' : 's'} will be created`;
  return empty > 0 ? `${created}, ${empty} record${empty === 1 ? ' is' : 's are'} empty and stay${empty === 1 ? 's' : ''} empty` : created;
}
