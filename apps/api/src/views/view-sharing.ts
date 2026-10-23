import { randomBytes } from 'node:crypto';
import type { ViewConfig } from '@storyos/schemas';

/**
 * #1041 — public tokens are credentials, so the SERVER mints them and a copy never carries one.
 *
 * A form's `public_token` used to be chosen by the browser, stored as sent, copied by "Duplicate view" and by pack
 * export/install, and found by a JSONB scan with `LIMIT 1` and no ordering. Anyone who had ever seen a form link could
 * register the same token in their own workspace and the lookup picked either one, so a respondent's answers could land
 * in the attacker's database; an "unpublished" original stayed live through its duplicate.
 */
export const mintPublicToken = (): string => randomBytes(24).toString('base64url');

type FormCfg = NonNullable<ViewConfig['form']>;

/**
 * The form block as it should be STORED. A client-supplied `public_token` is ignored outright; the live token is the
 * existing one, or a fresh one minted here the first time access moves off `members`. Moving back to `members` drops the
 * token, so "Stop sharing" really retires the link and sharing again gives a NEW one (rotation).
 */
export function resolveFormSharing(incoming: FormCfg | undefined, existing: FormCfg | undefined): FormCfg | undefined {
  if (!incoming) return existing;
  const access = incoming.access ?? existing?.access ?? 'members';
  const { public_token: _ignored, ...rest } = incoming;
  void _ignored;
  if (access === 'members') return { ...rest, access };
  return { ...rest, access, public_token: existing?.public_token ?? mintPublicToken() };
}

/**
 * A copy of a view config with every public credential removed: the form's token (and the form goes back to members-only,
 * so it fails closed instead of serving a link that no longer exists) and the published-view `share` block. Used by
 * duplicate, pack export and pack install: a copy is a NEW thing and must be published deliberately.
 */
export function stripPublicSharing<T extends Record<string, unknown> | null | undefined>(config: T): T {
  if (!config || typeof config !== 'object') return config;
  const next: Record<string, unknown> = { ...config };
  delete next['share'];
  const form = next['form'] as Record<string, unknown> | undefined;
  if (form && typeof form === 'object') {
    const { public_token: _t, ...rest } = form;
    void _t;
    next['form'] = { ...rest, access: 'members' };
  }
  return next as T;
}
