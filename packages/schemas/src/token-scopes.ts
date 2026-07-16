import { z } from 'zod';

/**
 * MN-134: a personal access token / MCP connection carries a scope that caps what
 * it can do, enforced server-side on every request.
 *
 *   read   — list, describe, get, query, search: look but never change
 *   write  — read + create/update/delete records, links, comments, attachments,
 *            run buttons (data work; delete is soft/restorable)
 *   admin  — write + schema (databases, fields, relations, views) and management
 *
 * The ladder is total, so a required-scope check is a simple rank comparison.
 */
export const tokenScopeSchema = z.enum(['read', 'write', 'admin']);
export type TokenScope = z.infer<typeof tokenScopeSchema>;

export const TOKEN_SCOPE_RANK: Record<TokenScope, number> = { read: 0, write: 1, admin: 2 };

/** Does a token with `have` satisfy an endpoint requiring `need`? */
export function scopeSatisfies(have: TokenScope, need: TokenScope): boolean {
  return TOKEN_SCOPE_RANK[have] >= TOKEN_SCOPE_RANK[need];
}

export const TOKEN_SCOPE_LABELS: Record<TokenScope, string> = {
  read: 'Read-only — look at data, never change it',
  write: 'Read & write — create, edit, delete records and run buttons; no schema changes',
  admin: 'Full access — everything this account can do, including schema',
};
