/**
 * Ticket #1186 — what a row on Settings › Workspace › Packs says and offers, as pure functions of one installed pack.
 *
 * The data is the existing `GET /packs/installed` summary (`InstallSummary` in `components/pack-install-dialog.tsx`): version,
 * `latest_version` and `update_available`, which the API computes with `compareSemver` and the marketplace page already reads. Nothing
 * here decides whether an update exists; this only says it. Update opens the same `InstallDialog` the marketplace uses (its update
 * mode, #978), and Uninstall asks through the shared confirm (`confirmUninstallPack`, `lib/settings-confirmations.ts`).
 */
export interface InstalledPackLike {
  id: string;
  slug: string;
  name: string;
  version: string;
  installed_at: string;
  installed_by: string;
  latest_version: string | null;
  update_available: boolean;
}

export type PackSource = 'registry' | 'marketplace';

export interface InstalledPackRow {
  id: string;
  name: string;
  /** "1.0.0": shown beside the name. */
  version: string;
  /** "Installed 26 Jul by Ievgen": the person is left out when no member matches the id, never guessed. */
  detail: string;
  status: { tone: 'ok' | 'warn'; label: string };
  /** "Update to v1.1.0", or null when the pack is current. */
  updateLabel: string | null;
  uninstallAriaLabel: string;
}

export function installedPackRow(pack: InstalledPackLike, date: (iso: string) => string, installedByName: string | null): InstalledPackRow {
  const updatable = pack.update_available && pack.latest_version !== null;
  return {
    id: pack.id,
    name: pack.name,
    version: pack.version,
    detail: `Installed ${date(pack.installed_at)}${installedByName ? ` by ${installedByName}` : ''}`,
    status: updatable ? { tone: 'warn', label: 'Update available' } : { tone: 'ok', label: 'Up to date' },
    updateLabel: updatable ? `Update to v${pack.latest_version}` : null,
    uninstallAriaLabel: `Uninstall ${pack.name}`,
  };
}

/** The line under the heading: "2 packs installed · 1 update available", or the empty state. */
export function installedPacksSummary(packs: ReadonlyArray<Pick<InstalledPackLike, 'update_available'>>): string {
  if (packs.length === 0) return 'No packs installed';
  const updates = packs.filter((p) => p.update_available).length;
  const base = `${packs.length} ${packs.length === 1 ? 'pack' : 'packs'} installed`;
  return updates > 0 ? `${base} · ${updates} ${updates === 1 ? 'update' : 'updates'} available` : base;
}

/** An installed pack updates through the registry or the marketplace, whichever lists its slug: the dialog needs to know which. */
export function packSourceFor(slug: string, registrySlugs: ReadonlySet<string>): PackSource {
  return registrySlugs.has(slug) ? 'registry' : 'marketplace';
}

export const PACKS_EMPTY = {
  title: 'No packs installed',
  body: 'A pack is a ready-made set of databases, views, automations and agents. Browse the gallery to install one.',
} as const;
