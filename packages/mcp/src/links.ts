/**
 * Web-app URL construction (#268): every MCP tool that returns a record should
 * be able to hand the agent a clickable link, instead of leaving it to describe
 * a manual navigation path (workspace → space → database → record).
 *
 * Mirrors the route scheme in apps/web/src/lib/records.ts and the
 * router.push/Link call sites across apps/web/src — those always address the
 * `ws`/`db` route segments by the resource's raw uuid (never a slug; the API's
 * workspace-access guard requires a uuid for `{ws}` too), and the record segment
 * by `{title-slug}-{number}` when the record has a public number, falling back
 * to the record's uuid otherwise. packages/mcp doesn't depend on the web app, so
 * this is a deliberate, small duplication — keep it in sync with records.ts by
 * hand if that scheme ever changes.
 */

/** Public web origin, e.g. https://app.storyos.dev — the same `WEB_URL` the API
 * and web app use for links (invites, email templates). Defaults to the local
 * dev web server. */
export function webBaseUrl(): string {
  return (process.env.WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
}

/** `{title-slug}-{number}`, or null when the record has no public number yet
 * (matches apps/web/src/lib/records.ts:recordSlug exactly). */
function recordSlug(title: string | null | undefined, number: number | null | undefined): string | null {
  if (number === null || number === undefined) return null;
  const base = (title ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return base ? `${base}-${number}` : String(number);
}

/** The web-app link to a database's default (table) view. */
export function databaseUrl(wsId: string, dbId: string): string {
  return `${webBaseUrl()}/w/${wsId}/d/${dbId}`;
}

/** The web-app link to one saved view of a database. */
export function viewUrl(wsId: string, dbId: string, viewId: string): string {
  return `${databaseUrl(wsId, dbId)}?view=${viewId}`;
}

/** The web-app link to one record — works whether the record was addressed by
 * its public number or its uuid; the link itself always resolves either way
 * (the route parses a trailing `-{number}` or falls back to the uuid). */
export function recordUrl(
  wsId: string,
  dbId: string,
  record: { id: string; title?: string | null; number?: number | null },
): string {
  const seg = recordSlug(record.title, record.number) ?? record.id;
  return `${databaseUrl(wsId, dbId)}/r/${seg}`;
}
