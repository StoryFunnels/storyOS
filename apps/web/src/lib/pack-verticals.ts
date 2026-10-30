/**
 * #1149 — which "kind of work" filter each registry pack sits under, BY SLUG.
 *
 * It was an if-chain that fell through to 'other', so a pack nobody added to it (dev-tracker, #1148) silently landed under
 * Other while the prototype files it under Engineering — nothing failed. An explicit record plus a test that every slug in the
 * API's registry has an entry (pack-verticals.unit.test.ts) turns that quiet fall-through into a failing test. The values are
 * the prototype's (dara-prototype-latest.html, the `PACKS` table).
 */
export const REGISTRY_VERTICALS: Record<string, string> = {
  'agency-os': 'agency',
  'client-portal': 'agency',
  'consulting-os': 'agency',
  'content-engine': 'marketing',
  'social-command-center': 'marketing',
  'dev-project-os': 'engineering',
  'dev-tracker': 'engineering',
  'support-inbox': 'support',
  'coaching-os': 'ops',
  'team-board': 'ops',
  'book-launch': 'other',
  'team-wiki': 'other',
};

/** A pack not in the record (a community or future pack) is 'other' — the one place that fallback lives. */
export function registryVertical(slug: string): string {
  return REGISTRY_VERTICALS[slug] ?? 'other';
}
