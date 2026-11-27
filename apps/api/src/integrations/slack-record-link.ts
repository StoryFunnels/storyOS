import { looksLikeRecordNumber } from '../common/record-ref';

export interface RecordLink {
  workspaceId: string;
  databaseId: string;
  /** The `{rec}` segment: a record uuid or its canonical public number. Resolved against `databaseId` by the caller. */
  recordRef: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RECORD_PATH = new RegExp(`^/w/(${UUID})/d/(${UUID})/r/([^/]+)/?$`, 'i');

/**
 * Ticket #1379 - a pasted URL to the record it names, or null. Pure: it reads the string and decides nothing about access.
 *
 * The link must be on the SAME origin as `WEB_URL` (scheme, host and port): a link to anywhere else is not ours to answer, whatever
 * its path looks like, and a look-alike host (`app.example.com.evil.net`) never matches because origins are compared whole.
 * The shape is the one the web app routes and the product itself writes (`/w/<workspace>/d/<database>/r/<number or uuid>`, see
 * `github-webhook.service.ts`); a link in any other shape simply gets no preview, which is the safe direction to be wrong in.
 */
export function parseRecordLink(rawUrl: string, webUrl: string): RecordLink | null {
  let url: URL;
  let web: URL;
  try {
    url = new URL(rawUrl);
    web = new URL(webUrl);
  } catch {
    return null;
  }
  if (url.origin !== web.origin || url.username || url.password) return null;
  const m = RECORD_PATH.exec(url.pathname);
  if (!m) return null;
  const [, workspaceId, databaseId, ref] = m as unknown as [string, string, string, string];
  const isUuid = new RegExp(`^${UUID}$`, 'i').test(ref);
  if (!isUuid && !looksLikeRecordNumber(ref)) return null;
  return { workspaceId: workspaceId.toLowerCase(), databaseId: databaseId.toLowerCase(), recordRef: isUuid ? ref.toLowerCase() : ref };
}
