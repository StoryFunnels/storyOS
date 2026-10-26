import type { EffectiveRole } from '@/lib/access';

/**
 * #924 — the Share / Manage access dialog's model (ADR-0018 v1, design by Dara on the ticket).
 *
 * Everything the dialog DECIDES lives here as plain functions of three inputs (the target, the people, the grants) so each
 * rule has a test and the dialog only draws. Two things are deliberately one place each, because the pending answers on
 * #1021 (who may share, default-private spaces, externals as guests) must land as additions, not rewrites:
 *  - `canManageAccess`: who gets the menu item. Admin only in v1.
 *  - `addablePeople`: who the add box offers.
 * and `ACCESS_CARDS` is data, so a third default can be a third card.
 *
 * Restriction is STICKY (ADR-0018 §2–3): a database that is itself restricted is opened only by a grant on that database,
 * never by a grant on its space. "Inherited" access therefore exists only for an UNRESTRICTED database inside a restricted
 * space.
 */
export type GrantRole = Exclude<EffectiveRole, 'admin'>;

export const GRANT_ROLE_ORDER: readonly GrantRole[] = ['viewer', 'commenter', 'contributor', 'editor', 'creator'];

export const ROLE_WORDS: Record<GrantRole, { label: string; hint: string }> = {
  viewer: { label: 'Viewer', hint: 'Can read' },
  commenter: { label: 'Commenter', hint: 'Can read and comment' },
  contributor: { label: 'Contributor', hint: 'Can add and edit records, never delete' },
  editor: { label: 'Editor', hint: 'Can add, edit and delete records' },
  creator: { label: 'Creator', hint: 'Can also change fields, views and automations' },
};

const rank = (r: GrantRole) => GRANT_ROLE_ORDER.indexOf(r);
export const higherRole = (a: GrantRole, b: GrantRole): GrantRole => (rank(a) >= rank(b) ? a : b);
export const isGrantRole = (v: string): v is GrantRole => (GRANT_ROLE_ORDER as readonly string[]).includes(v);

export type WorkspaceRole = 'admin' | 'member' | 'guest';

export interface Person {
  userId: string;
  name: string;
  workspaceRole: WorkspaceRole;
}

export interface Grant {
  id: string;
  userId: string;
  role: GrantRole;
  spaceId: string | null;
  databaseId: string | null;
}

export interface SpaceTarget {
  kind: 'space';
  id: string;
  name: string;
  restricted: boolean;
}

export interface DatabaseTarget {
  kind: 'database';
  id: string;
  name: string;
  restricted: boolean;
  /** Decided by the API's `is_system` flag, never the name (ADR-0017). */
  isSystem: boolean;
  space: { id: string; name: string; restricted: boolean };
}

export type Target = SpaceTarget | DatabaseTarget;

/** The ONE gate for who may open Manage access. Admin only in v1 (ADR-0018 §6); #1021 may widen it here and nowhere else. */
export function canManageAccess(workspaceRole: string | undefined): boolean {
  return workspaceRole === 'admin';
}

/** Does the sidebar draw a lock? Only on an item whose OWN flag is set: a database closed only by its space's restriction
 *  carries no lock (the space header does), and people without access never see the item at all. */
export const showsLock = (t: { restricted?: boolean }): boolean => t.restricted === true;

export type AccessMode = 'system' | 'everyone' | 'inherited' | 'restricted';

/** `inherited`: an unrestricted database inside a restricted space. */
export function accessMode(t: Target): AccessMode {
  if (t.kind === 'database' && t.isSystem) return 'system';
  if (t.restricted) return 'restricted';
  if (t.kind === 'database' && t.space.restricted) return 'inherited';
  return 'everyone';
}

/** Grants that sit directly on this target. */
export function directGrants(t: Target, grants: readonly Grant[]): Grant[] {
  return grants.filter((g) => (t.kind === 'space' ? g.spaceId === t.id : g.databaseId === t.id));
}

/** For a database: the grants on its space (empty for a space). */
export function spaceGrants(t: Target, grants: readonly Grant[]): Grant[] {
  return t.kind === 'database' ? grants.filter((g) => g.spaceId === t.space.id && g.databaseId === null) : [];
}

export interface AccessCard {
  key: 'everyone' | 'restricted';
  label: string;
  consequence: string;
}

/** Data, not markup: a third default is a third entry. The first label names the scope a database falls back to. */
export function accessCards(t: Target): AccessCard[] {
  const inRestrictedSpace = t.kind === 'database' && t.space.restricted;
  const noun = t.kind === 'space' ? 'space' : 'database';
  return [
    {
      key: 'everyone',
      label: inRestrictedSpace ? `Everyone in ${(t as DatabaseTarget).space.name}` : 'Everyone in the workspace',
      consequence: inRestrictedSpace
        ? `Anyone who can open the space can open this ${noun}.`
        : `Every member can open this ${noun} as a creator. Guests only where they were added.`,
    },
    {
      key: 'restricted',
      label: 'Restricted',
      consequence: `Only admins and the people added can see this ${noun}. Everyone else does not see it anywhere.`,
    },
  ];
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
const personOf = (people: readonly Person[], id: string) => people.find((p) => p.userId === id);

export interface PersonRow {
  person: Person;
  grant: Grant | null;
  role: GrantRole | null;
  /** Read-only: comes from the space, edited there. */
  fromSpace: boolean;
  /** Both a space grant and a direct grant: the higher wins, and the row says where the other comes from. */
  alsoFromSpaceRole: GrantRole | null;
}

export interface AccessView {
  mode: AccessMode;
  admins: Person[];
  /** everyone mode: the single "everyone" summary row. */
  everyone: { admins: number; members: number } | null;
  /** Rows the dialog lets you edit (direct grants). */
  added: PersonRow[];
  /** Read-only rows inherited from the space. */
  inherited: PersonRow[];
  /** Members who hold a grant here: it matters only if this is restricted (ADR-0018 §8). */
  membersWithGrants: Person[];
  /** Sticky note: people with access to the space who do NOT see this restricted database. */
  stickyHidden: Person[];
  /** Restricted and only admins can see it. */
  empty: boolean;
}

export function accessView(t: Target, people: readonly Person[], grants: readonly Grant[]): AccessView {
  const mode = accessMode(t);
  const admins = people.filter((p) => p.workspaceRole === 'admin').sort(byName);
  const members = people.filter((p) => p.workspaceRole === 'member');
  const direct = directGrants(t, grants);
  const fromSpaceGrants = spaceGrants(t, grants);

  const rowFor = (g: Grant): PersonRow | null => {
    const person = personOf(people, g.userId);
    if (!person || person.workspaceRole === 'admin') return null; // admins are always shown as admins, never as grants
    const space = fromSpaceGrants.find((s) => s.userId === g.userId);
    return { person, grant: g, role: g.role, fromSpace: false, alsoFromSpaceRole: space ? space.role : null };
  };

  const directRows = direct.flatMap((g) => rowFor(g) ?? []);
  const directIds = new Set(directRows.map((r) => r.person.userId));

  // Space grants a database can see: for an unrestricted database. A restricted one is opened only by its own grants.
  const showInherited = t.kind === 'database' && !t.restricted;
  const inheritedRows: PersonRow[] = showInherited
    ? fromSpaceGrants.flatMap((g) => {
        const person = personOf(people, g.userId);
        if (!person || person.workspaceRole === 'admin') return [];
        // In everyone mode only guests matter (members already see everything); in inherited mode every holder does.
        if (mode === 'everyone' && person.workspaceRole !== 'guest') return [];
        if (directIds.has(g.userId)) return [];
        return [{ person, grant: g, role: g.role, fromSpace: true, alsoFromSpaceRole: null }];
      })
    : [];

  const stickyHidden =
    t.kind === 'database' && t.restricted && t.space.restricted
      ? fromSpaceGrants
          .flatMap((g) => {
            const person = personOf(people, g.userId);
            return person && person.workspaceRole !== 'admin' && !directIds.has(g.userId) ? [person] : [];
          })
          .sort(byName)
      : [];

  const visibleDirect = mode === 'everyone' ? directRows.filter((r) => r.person.workspaceRole === 'guest') : directRows;
  return {
    mode,
    admins,
    everyone: mode === 'everyone' ? { admins: admins.length, members: members.length } : null,
    added: visibleDirect.sort((a, b) => byName(a.person, b.person)),
    inherited: inheritedRows.sort((a, b) => byName(a.person, b.person)),
    membersWithGrants: mode === 'everyone' ? directRows.filter((r) => r.person.workspaceRole === 'member').map((r) => r.person) : [],
    stickyHidden,
    empty: mode === 'restricted' && directRows.length === 0,
  };
}

/**
 * Who the add box offers. ONE place (the population is a pending decision on #1021):
 *  - everyone mode, add a guest: guests without a grant here.
 *  - restricted / inherited, add people: members and guests without a grant here. Never an admin (always has access).
 */
export function addablePeople(t: Target, people: readonly Person[], grants: readonly Grant[]): Person[] {
  const mode = accessMode(t);
  if (mode === 'system') return [];
  const taken = new Set(directGrants(t, grants).map((g) => g.userId));
  return people
    .filter((p) => p.workspaceRole !== 'admin' && !taken.has(p.userId))
    .filter((p) => (mode === 'everyone' ? p.workspaceRole === 'guest' : true))
    .sort(byName);
}

export interface LoseAccess {
  person: Person;
  /** What "Keep" would grant: members keep as Editor, guests keep the role they have. */
  keepAs: GrantRole;
  /** Why they can see it now, for the row's subline. */
  via: 'workspace' | 'space';
}

/**
 * Everyone → Restricted: who can see this now and will not once it is restricted (and has no grant of their own to keep them).
 * Admins always keep access. Restricting is sticky, so a database loses its space-grant holders too.
 */
export function restrictPreview(t: Target, people: readonly Person[], grants: readonly Grant[]): LoseAccess[] {
  const direct = new Set(directGrants(t, grants).map((g) => g.userId));
  const space = spaceGrants(t, grants);
  const spaceRole = (id: string) => space.find((g) => g.userId === id)?.role ?? null;
  const spaceClosed = t.kind === 'database' && t.space.restricted;
  const out: LoseAccess[] = [];
  for (const p of people) {
    if (p.workspaceRole === 'admin' || direct.has(p.userId)) continue;
    const viaSpace = spaceRole(p.userId);
    if (spaceClosed) {
      // The database is open only to the space's holders today.
      if (viaSpace) out.push({ person: p, keepAs: p.workspaceRole === 'guest' ? viaSpace : 'editor', via: 'space' });
    } else if (p.workspaceRole === 'member') {
      out.push({ person: p, keepAs: 'editor', via: 'workspace' });
    } else if (viaSpace) {
      // A guest on an open database sees it only through its space grant, which restriction no longer honours.
      out.push({ person: p, keepAs: viaSpace, via: 'space' });
    }
  }
  return out.sort((a, b) => byName(a.person, b.person));
}

export interface OpenPreview {
  /** Members who gain access (no grant here today). */
  gaining: Person[];
  /** Members whose role here WIDENS to creator: their grant is ignored on an open resource (ADR-0018 §2). */
  widening: Array<{ person: Person; today: GrantRole }>;
  /** Members count seeing it as creators once open (all of them), for the headline. */
  members: number;
  /** For a space: its own databases that are restricted and stay closed. */
  staysClosed: string[];
  /** A database falling back to its restricted space: no workspace-wide widening. */
  withinSpace: boolean;
}

/** Restricted → Everyone. Grants are kept (restricting again brings the same people back); only the widening is named. */
export function openPreview(
  t: Target,
  people: readonly Person[],
  grants: readonly Grant[],
  restrictedDatabaseNames: readonly string[] = [],
): OpenPreview {
  const members = people.filter((p) => p.workspaceRole === 'member');
  const direct = directGrants(t, grants);
  const withinSpace = t.kind === 'database' && t.space.restricted;
  if (withinSpace) {
    const space = spaceGrants(t, grants);
    const holders = new Set(direct.map((g) => g.userId));
    const gaining = space
      .flatMap((g) => {
        const p = personOf(people, g.userId);
        return p && p.workspaceRole !== 'admin' && !holders.has(g.userId) ? [p] : [];
      })
      .sort(byName);
    return { gaining, widening: [], members: members.length, staysClosed: [], withinSpace: true };
  }
  const grantOf = new Map(direct.map((g) => [g.userId, g.role]));
  const gaining = members.filter((m) => !grantOf.has(m.userId)).sort(byName);
  const widening = members
    .flatMap((m) => {
      const today = grantOf.get(m.userId);
      return today && today !== 'creator' ? [{ person: m, today }] : [];
    })
    .sort((a, b) => byName(a.person, b.person));
  return {
    gaining,
    widening,
    members: members.length,
    staysClosed: t.kind === 'space' ? [...restrictedDatabaseNames] : [],
    withinSpace: false,
  };
}

/** "Mira and Lena", "Iris, Marek and Vera": the names in a sentence. */
export function nameList(names: readonly string[], max = 4): string {
  if (names.length === 0) return '';
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  const parts = rest > 0 ? [...shown, `${rest} more`] : shown;
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
