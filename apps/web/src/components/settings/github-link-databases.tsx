'use client';

import { SettingsBox, SettingsRow } from '@/components/settings/settings-chrome';
import { MenuSelect } from '@/components/ui/menu-select';
import {
  NO_LINK_DATABASE,
  linkOptionLabel,
  linkRowHint,
  linkRows,
  type LinkConfig,
  type LinkDatabaseOption,
} from '@/lib/github-link-databases';

/**
 * Ticket #1368: which database each watched repository links its pull requests into. A branch like `story-3` or `feat/issue-5201`
 * resolves against THIS database only, so two repositories can each have their own tickets without one moving the other's.
 */
export function GithubLinkDatabases({
  config,
  databases,
  saving,
  onChange,
}: {
  config: LinkConfig;
  /** undefined while the list is loading or could not be read: a row then claims nothing about its database. */
  databases: LinkDatabaseOption[] | undefined;
  saving: boolean;
  onChange: (repo: string, databaseId: string) => void;
}) {
  const rows = linkRows(config);
  if (rows.length === 0) return null;
  const options = [
    { value: NO_LINK_DATABASE, label: 'No link database' },
    ...(databases ?? []).map((d) => ({ value: d.id, label: linkOptionLabel(d) })),
  ];
  return (
    <div data-testid="github-link-databases">
      <SettingsBox title="Link database per repository">
        {rows.map((row) => (
          <SettingsRow
            key={row.repo}
            testId="github-link-row"
            title={<code className="block font-mono text-meta leading-[1.35]!">{row.repo}</code>}
            description={databases ? linkRowHint(row, databases.find((d) => d.id === row.databaseId)) : 'Reading the databases…'}
          >
            <MenuSelect
              label={`Link database for ${row.repo}`}
              value={row.databaseId ?? NO_LINK_DATABASE}
              options={options}
              disabled={saving || !databases}
              className="max-w-[14rem]"
              contentClassName="w-64"
              onChange={(value) => onChange(row.repo, value)}
            />
          </SettingsRow>
        ))}
      </SettingsBox>
    </div>
  );
}
