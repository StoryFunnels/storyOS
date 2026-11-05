/**
 * The sidebar's "Hidden" section (ticket #1211): every space that is not in the main Spaces list, and where a search
 * result for a place goes.
 *
 * Two reasons a space is hidden, shown the same way:
 *  - `system`: it holds only the Agentic OS system databases (ticket #1058 moved them to the AI section), decided by
 *    `isSystemOnlySpace` from the `is_system` flag, never from a name;
 *  - `mine`: this person hid it (`useHidden`, per person, per device).
 *
 * ACCESS IS NOT DECIDED HERE. The `spaces` argument is what the API returned to this person, and the API's door
 * (`visibleSpaceIds` + `canSeePersonal`, never `assertSpace`) already dropped everything they cannot open. This model only
 * ever narrows that list, so a hidden space the person cannot open never appears; there is no code path here that adds one.
 * Nothing is deleted, moved or re-owned: Hidden is a place in the tree, not a container (views-and-the-sidebar.md).
 */
import { agentSystemKey } from './system-databases';

interface SpaceLike {
  id: string;
  personal?: boolean | null;
}
interface DatabaseLike {
  id: string;
  spaceId: string;
  name: string;
  isSystem?: boolean;
}

export type HiddenSpaceReason = 'system' | 'mine';

export interface HiddenSectionModel<S extends SpaceLike, D extends DatabaseLike> {
  spaces: Array<{ space: S; reason: HiddenSpaceReason }>;
  databases: D[];
  count: number;
}

export function hiddenSectionModel<S extends SpaceLike, D extends DatabaseLike>(input: {
  spaces: readonly S[];
  databases: readonly D[];
  isHidden: (kind: 'space' | 'database', id: string) => boolean;
  /** Spaces the sidebar found to hold only Agentic OS system databases (reported by each space's own row). */
  systemOnlySpaceIds: ReadonlySet<string>;
}): HiddenSectionModel<S, D> {
  const { isHidden, systemOnlySpaceIds } = input;
  // The personal space has its own section and is private: never listed here, hidden or not.
  const shared = input.spaces.filter((s) => !s.personal);
  const spaces: Array<{ space: S; reason: HiddenSpaceReason }> = [];
  for (const space of shared) {
    if (systemOnlySpaceIds.has(space.id)) spaces.push({ space, reason: 'system' });
    else if (isHidden('space', space.id)) spaces.push({ space, reason: 'mine' });
  }
  const inHiddenSpace = new Set(spaces.map((s) => s.space.id));
  // A database hidden on its own while its space is still shown. The Agentic OS databases are never listed one by one:
  // they live in the AI section, and their space is listed above.
  const databases = input.databases.filter(
    (d) => isHidden('database', d.id) && !inHiddenSpace.has(d.spaceId) && agentSystemKey(d) === null,
  );
  return { spaces, databases, count: spaces.length + databases.length };
}

/** Collapsed unless this person opened it; remembered per workspace the way a space's own collapse is. */
export const hiddenSectionOpenKey = (ws: string) => `storyos:hidden-section-open:${ws}`;
export function readHiddenSectionOpen(raw: string | null): boolean {
  return raw === '1';
}

/**
 * Where a search result for a PLACE opens. A space opens its own page; before ticket #1211 every space result went to the
 * workspace home, so choosing a space from search (Agentic OS above all) landed on the page you were already looking at.
 */
export function placeHref(ws: string, place: { kind: 'database' | 'space'; id: string }): string {
  return place.kind === 'database' ? `/w/${ws}/d/${place.id}` : `/w/${ws}/s/${place.id}`;
}
