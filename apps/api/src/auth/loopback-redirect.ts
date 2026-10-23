import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { oauthApplication } from '../db/auth-schema';

/**
 * #1030 / RFC 8252 §7.3 — a native client (Claude Code, a CLI) listens on a RANDOM loopback port and cannot know it when it registers.
 * The spec says the authorization server must then ignore the port of a loopback redirect. better-auth only accepts a redirect URI
 * that is byte-for-byte registered, so the one case allowed to differ is handled here: when the request names a loopback URI that
 * matches a registered one in everything but the port, that exact URI is added to the client's registered list first. Everything
 * else still has to match exactly, and the stored list stays bounded.
 */
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** A client that cycles ports cannot grow its registration without limit. */
export const MAX_REGISTERED_REDIRECTS = 20;

const parseLoopback = (uri: string): URL | null => {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || u.username || u.password || u.hash || uri.includes(',')) return null;
    return u;
  } catch {
    return null;
  }
};

/** Whether `requested` is a loopback URI that differs from `registered` only by port. */
export function sameLoopbackIgnoringPort(requested: string, registered: string): boolean {
  const a = parseLoopback(requested);
  const b = parseLoopback(registered);
  return !!a && !!b && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

export async function allowLoopbackPort(db: Db, clientId: string, requested: string): Promise<void> {
  if (!parseLoopback(requested)) return;
  const [client] = await db.select({ id: oauthApplication.id, redirectUrls: oauthApplication.redirectUrls }).from(oauthApplication).where(eq(oauthApplication.clientId, clientId)).limit(1);
  if (!client?.redirectUrls) return;
  const registered = client.redirectUrls.split(',').filter(Boolean);
  if (registered.includes(requested) || registered.length >= MAX_REGISTERED_REDIRECTS) return;
  if (!registered.some((r) => sameLoopbackIgnoringPort(requested, r))) return;
  await db.update(oauthApplication).set({ redirectUrls: [...registered, requested].join(','), updatedAt: new Date() }).where(eq(oauthApplication.id, client.id));
}
