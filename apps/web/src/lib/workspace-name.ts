/**
 * Ticket #1186 — the workspace NAME, editable in Settings › General.
 *
 * The API has always accepted `name` on PATCH /workspaces/:ws (`updateWorkspaceSchema`: trimmed, 1 to 100 characters); the web app
 * never offered a field for it. This is what that field means, as pure functions, so the rules and the cache refresh can be tested
 * without a browser. The server stays the authority: `workspace-name.unit.test.ts` runs every case through the schema as well, so the
 * two cannot drift unnoticed.
 */

/** The server's bound (`updateWorkspaceSchema.name`). */
export const WORKSPACE_NAME_MAX = 100;

export interface WorkspaceNameDraft {
  /** What to send: the trimmed name, or null when it cannot be saved (empty, or too long). */
  value: string | null;
  /** The text under the field when something is wrong; null when the name is fine. */
  error: string | null;
  /** The characters the server will count (after trimming). */
  length: number;
  /** A name that differs from the saved one and can be sent. */
  canSave: boolean;
}

/**
 * Read what is typed in the box. An empty name is not "unconfigured": a workspace always has one, so clearing the box is refused with a
 * sentence, never sent. An over-long name is shown and blocked rather than silently cut (the same stance as the description counter).
 */
export function workspaceNameDraft(raw: string, saved: string): WorkspaceNameDraft {
  const trimmed = raw.trim();
  const length = trimmed.length;
  if (length === 0) return { value: null, error: 'A workspace needs a name.', length, canSave: false };
  if (length > WORKSPACE_NAME_MAX) {
    return {
      value: null,
      error: `${length - WORKSPACE_NAME_MAX} too many characters. A name can be up to ${WORKSPACE_NAME_MAX}.`,
      length,
      canSave: false,
    };
  }
  return { value: trimmed, error: null, length, canSave: trimmed !== saved };
}

/**
 * Every react-query cache that holds the workspace's name, refreshed after a rename. `['workspace', ws]` is this workspace's own record
 * (the sidebar header, the home page greeting, the Settings pages); `['workspaces']` is the list the workspace switcher, the Settings
 * home signals and the API tokens page read. Missing the second left the switcher showing the old name until a reload.
 */
export function workspaceNameCacheKeys(ws: string): ReadonlyArray<readonly unknown[]> {
  return [['workspace', ws], ['workspaces']];
}
