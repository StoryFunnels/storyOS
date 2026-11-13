'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Package } from 'lucide-react';
import { api } from '@/lib/api';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { InstallDialog, useInstalledPacks, useRegistry, type InstallSummary } from '@/components/pack-install-dialog';
import { AdvancedSection, SettingsBox, SettingsPageBody, SettingsPageHeader, SettingsPill, SettingsRow } from '@/components/settings/settings-chrome';
import { installedPackRow, installedPacksSummary, packSourceFor, PACKS_EMPTY, type PackSource } from '@/lib/installed-packs';
import { useDateFormat } from '@/lib/preferences';
import { useWorkspace } from '@/lib/queries';
import { confirmUninstallPack } from '@/lib/settings-confirmations';
import { useUninstallPack } from '@/lib/use-uninstall-pack';

interface MemberName {
  user: { id: string; name: string };
}

/**
 * Settings › Workspace › Packs (ticket #1186; held from #967): every pack installed in this workspace with its version, whether an
 * update is waiting, and Update / Uninstall. It reads the same installed-packs query the marketplace page reads (`useInstalledPacks`),
 * opens the same install dialog in its update mode, and asks Uninstall through the shared confirm. The marketplace itself, where a
 * pack is chosen and installed, stays at /packs: "Browse packs" goes there.
 *
 * Uninstall sits under Advanced, as drawn: it is a power control, one click further than reading the list.
 */
export default function PacksSettingsPage() {
  const { ws } = useParams<{ ws: string }>();
  const workspace = useWorkspace(ws);
  const installed = useInstalledPacks(ws);
  const registry = useRegistry();
  const fmt = useDateFormat();
  const confirm = useConfirm();
  const uninstall = useUninstallPack(ws);
  const [updating, setUpdating] = useState<{ pack: InstallSummary; source: PackSource } | null>(null);

  // `installed_by` is a user id; the members list (admin-only, and so is this page) turns it into a name. Unresolved: no name, never a guess.
  const members = useQuery({
    queryKey: ['members', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/members', { params: { path: { ws } } });
      if (error) throw error;
      return data as unknown as MemberName[];
    },
  });
  const nameOf = (userId: string) => members.data?.find((m) => m.user.id === userId)?.user.name ?? null;

  const registrySlugs = new Set((registry.data ?? []).map((p) => p.slug));
  const packs = installed.data ?? [];
  const browse = (
    <Link href={`/w/${ws}/packs`} className={cn(buttonVariants({ variant: 'secondary' }))}>
      Browse packs
    </Link>
  );

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <SettingsPageHeader
        title="Packs"
        lead={workspace.data ? `Packs installed in ${workspace.data.name}` : undefined}
        action={browse}
      />

      <SettingsPageBody>
        {installed.isLoading && <p className="text-body text-muted">Loading…</p>}
        {installed.isError && (
          <p className="text-body text-error" role="alert">
            Could not load the installed packs. Try again in a moment.
          </p>
        )}

        {installed.isSuccess && packs.length === 0 && (
          <SettingsBox>
            <SettingsRow title={PACKS_EMPTY.title} description={PACKS_EMPTY.body} leading={<PackMark />} />
          </SettingsBox>
        )}

        {packs.length > 0 && (
          <SettingsBox title="Installed" aside={installedPacksSummary(packs)}>
            {packs.map((pack) => {
              const row = installedPackRow(pack, (iso) => fmt.date(iso), nameOf(pack.installed_by));
              return (
                <SettingsRow
                  key={pack.id}
                  leading={<PackMark />}
                  title={
                    <>
                      {row.name} <span className="font-normal text-muted">{row.version}</span>
                    </>
                  }
                  description={row.detail}
                >
                  <SettingsPill tone={row.status.tone}>{row.status.label}</SettingsPill>
                  {row.updateLabel && (
                    <Button
                      size="sm"
                      onClick={() => setUpdating({ pack, source: packSourceFor(pack.slug, registrySlugs) })}
                    >
                      {row.updateLabel}
                    </Button>
                  )}
                </SettingsRow>
              );
            })}
          </SettingsBox>
        )}

        {packs.length > 0 && (
          <AdvancedSection title="Uninstall" summary="removes what a pack added; your databases and records stay">
            {packs.map((pack) => {
              const row = installedPackRow(pack, (iso) => fmt.date(iso), null);
              return (
                <SettingsRow
                  key={pack.id}
                  title={`Uninstall ${pack.name}`}
                  description="Removes its views, automations, agents and skills, except any you changed. Databases, fields and records stay."
                >
                  <Button
                    variant="secondary"
                    size="sm"
                    className="text-error"
                    aria-label={row.uninstallAriaLabel}
                    disabled={uninstall.isPending}
                    onClick={async () => {
                      if (await confirm(confirmUninstallPack(pack.name))) uninstall.mutate(pack.id);
                    }}
                  >
                    Uninstall…
                  </Button>
                </SettingsRow>
              );
            })}
          </AdvancedSection>
        )}
      </SettingsPageBody>

      {updating && (
        <InstallDialog
          ws={ws}
          slug={updating.pack.slug}
          source={updating.source}
          installed={updating.pack}
          onOpenChange={(open) => !open && setUpdating(null)}
        />
      )}
    </div>
  );
}

function PackMark() {
  return (
    <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[var(--radius-chip)] bg-hover text-ink-secondary" aria-hidden>
      <Package className="h-[13px] w-[13px]" />
    </span>
  );
}
