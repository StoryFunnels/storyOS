import type { LightMyRequestResponse } from 'fastify';

/**
 * #1041 — a form's public token is minted by the SERVER; a token sent by the client is ignored. Tests used to pick a
 * readable token and put it in the URL. They still NAME their forms with an alias (`tok-public`), and this maps the alias
 * to the token the server actually minted, learned from the response of the request that created or updated the view.
 */
const minted = new Map<string, string>();

export function trackFormToken(payload: unknown, res: Pick<LightMyRequestResponse, 'statusCode' | 'body'>): void {
  const alias = (payload as { config?: { form?: { public_token?: string } } } | undefined)?.config?.form?.public_token;
  if (!alias || res.statusCode >= 300) return;
  try {
    const real = (JSON.parse(res.body) as { config?: { form?: { public_token?: string } } }).config?.form?.public_token;
    if (real) minted.set(alias, real);
  } catch { /* not a view response */ }
}

/** The live token for a test's alias; an alias that was never created (a deliberately unknown token) stays as written. */
export const tk = (alias: string): string => minted.get(alias) ?? alias;

/** `/public/forms/<alias>/...` → the same path with the minted token. Anything else is returned untouched. */
export const liveFormUrl = (url: string): string => url.replace(/^(\/public\/forms\/)([^/?]+)/, (_m, p: string, a: string) => `${p}${tk(a)}`);
