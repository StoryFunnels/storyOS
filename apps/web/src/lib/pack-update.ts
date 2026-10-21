/**
 * #978 (part 1) — what the pack update dialog says, as pure functions so every sentence can be tested against the
 * code it describes. The rule for this file: a sentence states what the install code does TODAY, never a hope.
 * (Reads: apps/api/src/agents/architect.service.ts `ensureField`, the agent/view/automation `existing` branches, and
 * packs.service.ts `computeCollisions`.)
 */

export interface PackVersion {
  version: string;
  changelog?: string;
  published_at: string;
}

export type PackItemKind = 'database' | 'view' | 'automation' | 'agent';
export type PackItemAction = 'create' | 'reuse' | 'collision';

const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * The versions an update crosses: everything newer than `from` up to and including `to`, newest first. Compared as
 * dotted numbers ("1.10" is after "1.9"), not as text.
 */
export function versionsBetween(versions: PackVersion[], from: string, to: string): PackVersion[] {
  return versions.filter((v) => cmp(v.version, from) > 0 && cmp(v.version, to) <= 0).sort((a, b) => cmp(b.version, a.version));
}

export interface ReleaseNotes {
  /** The newest version's entry: "What's new in 1.5". Null when no version data exists at all (a built-in pack). */
  latest: PackVersion | null;
  /** The versions skipped over, newest first. */
  earlier: PackVersion[];
  /** True when no crossed version carries any author note. */
  noNotes: boolean;
}

export function releaseNotes(versions: PackVersion[] | undefined, from: string, to: string): ReleaseNotes {
  const crossed = versionsBetween(versions ?? [], from, to);
  const [latest = null, ...earlier] = crossed;
  return { latest, earlier, noNotes: !crossed.some((v) => (v.changelog ?? '').trim() !== '') };
}

/**
 * What installing will really do to one previewed item. `action` is the preview API's own classification
 * (`create` / `reuse` / `collision`); the sentence adds only what the install code does for that kind of thing.
 */
export function itemEffect(kind: PackItemKind, action: PackItemAction): string {
  if (action === 'create') return 'Will be created.';
  if (action === 'collision') return 'Something with this name already exists. You choose what happens below.';
  switch (kind) {
    case 'database':
      // ensureField: a field the pack needs is added unless one of that name exists; nothing existing is edited.
      return 'Already in your workspace. Kept as it is, except fields the pack needs that are missing are added.';
    case 'agent':
      // An existing agent is never touched (it may have been tuned by hand); updating one from a pack is #977.
      return 'Agent: kept as it is. Updating agents from a pack isn’t available yet.';
    default:
      return 'Already there. Kept as it is.';
  }
}
