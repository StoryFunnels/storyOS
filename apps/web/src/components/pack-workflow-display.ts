/**
 * #824 — how a pack's workflow is drawn in the 112px hero.
 *
 * A stage is an array of labels: one is a step, several are ALTERNATIVES at that
 * step (the API groups them; see apps/api/src/packs/pack-workflow.ts). The two
 * ways a pipeline outgrows its row are collapsed with two DIFFERENT marks because
 * they mean different things (Dara's v4 catch):
 *
 *   `+N` between arrows   — N states hidden IN SEQUENCE
 *   `/ +N` on a chip      — N ALTERNATIVES parallel to the label shown
 *
 * "Won +1" would read as a fifth step after Won when Lost is its opposite, in a
 * sales pipeline — a real misreading. The slash is the separator the pack's own
 * text uses ("Won / Lost"), so alternation keeps its own vocabulary.
 */
export type HeroChip =
  | { kind: 'step'; label: string; alt: number; end: boolean }
  | { kind: 'more'; hidden: number };

/** More than this and the chips wrap to a second row, eating the marks line. */
export const MAX_FULL_STAGES = 5;

export function heroChips(stages: string[][]): HeroChip[] {
  const steps = stages.map((labels) => ({ label: labels[0] ?? '', alt: Math.max(0, labels.length - 1) }));
  const picked: Array<{ label: string; alt: number } | { hidden: number }> =
    steps.length > MAX_FULL_STAGES
      ? [steps[0]!, steps[1]!, { hidden: steps.length - 4 }, steps[steps.length - 2]!, steps[steps.length - 1]!]
      : steps;
  return picked.map((s, i) =>
    'hidden' in s
      ? { kind: 'more' as const, hidden: s.hidden }
      : { kind: 'step' as const, label: s.label, alt: s.alt, end: i === picked.length - 1 },
  );
}

/** Spoken form of the whole workflow, for the hero's aria-label (nothing is elided here). */
export function workflowSentence(stages: string[][]): string {
  return stages.map((labels) => (labels.length > 1 ? labels.join(' or ') : labels[0])).join(', then ');
}

/**
 * A hue per pack, so a grid of eight stays apart. Built-ins are pinned (their hues
 * were chosen together, by eye, against each other); any other slug — a community
 * pack — falls back to a stable hash, so nobody has to maintain a list for packs
 * nobody here has seen. Names are keys of OPTION_COLORS, the product's one chip
 * palette, so contrast in both themes is the already-audited `option-tint` (#638).
 */
const PINNED_HUES: Record<string, string> = {
  'agency-os': 'gold',
  'content-engine': 'purple',
  'dev-project-os': 'blue',
  'consulting-os': 'green',
  'book-launch': 'orange',
  'support-inbox': 'teal',
  'client-portal': 'brown',
  'coaching-os': 'red',
};
const FALLBACK_HUES = ['indigo', 'cyan', 'pink', 'lime', 'magenta', 'rose'];

export function packHueName(slug: string): string {
  const pinned = PINNED_HUES[slug];
  if (pinned) return pinned;
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_HUES[h % FALLBACK_HUES.length]!;
}
