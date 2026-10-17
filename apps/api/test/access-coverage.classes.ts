/** #944 — the four answers to "who may see what this endpoint returns". */
export type AccessClass =
  | { kind: 'scoped'; check: string; file: string }
  | { kind: 'workspace-level'; reason: string }
  | { kind: 'admin-only'; reason?: string }
  | { kind: 'public'; reason: string };

/** Touches space/database/record content. `check` names the access primitive(s) it relies on; `file` is the module source that must still contain them. */
export const scoped = (check: string, file: string): AccessClass => ({ kind: 'scoped', check, file });
/** Touches no scoped content. The reason is mandatory; `UNAUDITED:` marks the backlog still to be looked at. */
export const workspaceLevel = (reason: string): AccessClass => ({ kind: 'workspace-level', reason });
/** `@MinRole('admin')`, or the platform-admin guard. */
export const adminOnly = (reason?: string): AccessClass => ({ kind: 'admin-only', reason });
/** No AuthGuard, on purpose. */
export const publicRoute = (reason: string): AccessClass => ({ kind: 'public', reason });
