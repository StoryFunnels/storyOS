import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PACK_FILTERS } from '@/components/pack-install-dialog';
import { REGISTRY_VERTICALS, registryVertical } from './pack-verticals';

/**
 * #1149 — every pack the API ships must sit under a kind-of-work filter ON PURPOSE. The slugs are read from the API's own pack
 * sources (not typed here), so a pack added there with no entry in REGISTRY_VERTICALS fails this test instead of falling through
 * to 'Other' unnoticed — which is what happened to dev-tracker (#1148) while the prototype files it under Engineering.
 */
const packsDir = join(__dirname, '../../../api/src/packs');
const slugsInApi = (): string[] => {
  const found = new Set<string>();
  for (const file of ['registry.ts', 'starter-packs.ts', 'social-command-center.ts']) {
    for (const m of readFileSync(join(packsDir, file), 'utf8').matchAll(/^\s+slug: '([a-z0-9-]+)'/gm)) found.add(m[1]!);
  }
  return [...found].sort();
};

describe('registry pack verticals (#1149)', () => {
  it('finds the packs (guards the regex: an empty list would make the next test vacuous)', () => {
    expect(slugsInApi().length).toBeGreaterThanOrEqual(9);
  });

  it('every slug the API ships has an explicit vertical, and it is a real filter', () => {
    const filters = new Set<string>(PACK_FILTERS.map((f) => f.value));
    for (const slug of slugsInApi()) {
      expect(REGISTRY_VERTICALS[slug], `${slug} has no entry in REGISTRY_VERTICALS`).toBeDefined();
      expect(filters.has(REGISTRY_VERTICALS[slug]!), `${slug} maps to a filter that does not exist`).toBe(true);
    }
  });

  it('files the three #1022 packs where the prototype does', () => {
    expect(registryVertical('team-board')).toBe('ops');
    expect(registryVertical('dev-tracker')).toBe('engineering');
    expect(registryVertical('team-wiki')).toBe('other');
  });

  it('keeps the older nine where they were, and an unknown pack is Other', () => {
    expect(registryVertical('agency-os')).toBe('agency');
    expect(registryVertical('dev-project-os')).toBe('engineering');
    expect(registryVertical('support-inbox')).toBe('support');
    expect(registryVertical('coaching-os')).toBe('ops');
    expect(registryVertical('book-launch')).toBe('other');
    expect(registryVertical('some-community-pack')).toBe('other');
  });
});
