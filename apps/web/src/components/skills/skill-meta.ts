import type { SkillSummary, SkillVisibility } from '@storyos/schemas';

/**
 * #833 — what the library SAYS about a skill, kept as plain functions so the
 * wording is testable and cannot drift between the row and the editor.
 *
 * The word "private" never appears here (Otto's ruling, #833): an admin can see
 * a personal skill, while personal SPACE content is private from admins by ADR.
 * One word with two meanings is the kind of difference people find at the worst
 * moment, so the chip says "Only me" (compact, claims nothing) and the picker —
 * the only place the caveat can change a decision — spells out who else sees it.
 */
export const VISIBILITY_CHIP: Record<SkillVisibility, string> = {
  personal: 'Only me',
  shared: 'Workspace',
};

export const VISIBILITY_OPTIONS: Array<{ value: SkillVisibility; label: string; hint: string }> = [
  {
    value: 'shared',
    label: 'Everyone in the workspace',
    hint: 'Every active member, and their AI, can find and run it.',
  },
  {
    value: 'personal',
    label: 'Only me — you and workspace admins',
    hint: 'Admins can see it too. Specific members and a public link are coming.',
  },
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "2d ago", "just now"… coarse on purpose: this is a currency signal, not a clock. */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  const diff = Math.max(0, now - t);
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 60 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return `${Math.floor(diff / (30 * DAY))}mo ago`;
}

/**
 * The last-run line. A CURRENCY SIGNAL, never an offer: StoryOS does run skills
 * (`run_skill` over MCP, and the row carries `last_run_at`/`last_run_status`),
 * and the library must not imply nothing ever ran. What it must not do is
 * offer to run one — see the AC6 note on SkillRow.
 */
export function runLine(
  skill: Pick<SkillSummary, 'last_run_at' | 'last_run_status'>,
  now: number,
): { text: string; failed: boolean } {
  if (!skill.last_run_at) return { text: 'never run', failed: false };
  const failed = skill.last_run_status === 'error';
  return { text: `ran ${relativeTime(skill.last_run_at, now)} · ${failed ? 'failed' : 'ok'}`, failed };
}

/** Initials for the author avatar; "?" when the name is unknown. */
export function initials(name: string | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : '')).toUpperCase();
}
