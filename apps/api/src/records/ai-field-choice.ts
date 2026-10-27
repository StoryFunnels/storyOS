/**
 * #1109 — an AI field's choice answer, reconciled with the configured options.
 *
 * A model asked for "exactly one of A, B, C" still sometimes answers `"B".` or
 * `b` or `**B**`. Those are the right answer in a slightly different dress, so
 * they match; anything else does not. The caller stores the OPTION'S OWN LABEL
 * (never the model's casing), and an unmatched answer is an error, never a
 * guessed value.
 */
export function matchChoice(answer: string, options: string[]): string | null {
  const exact = options.find((o) => o === answer);
  if (exact !== undefined) return exact;
  const cleaned = normalizeChoice(answer);
  if (cleaned === '') return null;
  const hits = options.filter((o) => normalizeChoice(o) === cleaned);
  // Two options that differ only in case/punctuation make the answer ambiguous: refuse rather than pick one.
  return hits.length === 1 ? hits[0]! : null;
}

function normalizeChoice(text: string): string {
  return text
    .trim()
    .replace(/^[\s"'`*_]+|[\s"'`*_.,;:!?]+$/g, '')
    .trim()
    .toLowerCase();
}

/** The instruction appended to a choice field's prompt so the model is told what the legal answers are. */
export function choiceInstruction(options: string[]): string {
  return `\n\nAnswer with exactly one of these options and nothing else: ${options.map((o) => `"${o}"`).join(', ')}.`;
}
