import type { Client } from './client.js';
import { unwrap } from './client.js';

/**
 * Name-or-id resolution (MN-076). IDs only ever come from a prior tool result or
 * these resolvers — the model never invents them. Accepting human names/slugs is
 * the "easy" half; resolving them server-truthfully is the "non-hallucinated" half.
 */

export interface WorkspaceRef {
  id: string;
  name: string;
  slug?: string;
  role?: string;
}

export interface DatabaseRef {
  id: string;
  name: string;
  apiSlug?: string;
  spaceId?: string;
  spaceSlug?: string | null;
  /** Canonical cross-space reference: `space/database` (MN-153). */
  qualifiedSlug?: string;
  icon?: string | null;
}

export async function listWorkspaces(client: Client): Promise<WorkspaceRef[]> {
  return unwrap<WorkspaceRef[]>(client.GET('/api/v1/workspaces'));
}

export async function resolveWorkspace(client: Client, ref: string): Promise<WorkspaceRef> {
  const list = await listWorkspaces(client);
  const lower = ref.trim().toLowerCase();
  const exact = list.find((w) => w.id === ref || w.name.toLowerCase() === lower || w.slug?.toLowerCase() === lower);
  if (exact) return exact;
  const partial = list.filter((w) => w.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(`"${ref}" matches multiple workspaces: ${partial.map((w) => w.name).join(', ')}. Be more specific.`);
  }
  throw new Error(`No workspace matches "${ref}". Available: ${list.map((w) => w.name).join(', ') || '(none)'}.`);
}

export async function listDatabases(client: Client, workspaceId: string): Promise<DatabaseRef[]> {
  // The list op under-documents its {ws} path param in the OpenAPI spec, so the
  // typed client rejects it though the substitution works at runtime (as in the web).
  return unwrap<DatabaseRef[]>(
    client.GET('/api/v1/workspaces/{ws}/databases', { params: { path: { ws: workspaceId } } } as never),
  );
}

/** How a candidate reads back to the model when it must disambiguate (MN-153). */
const qualify = (d: DatabaseRef) => d.qualifiedSlug ?? (d.spaceSlug ? `${d.spaceSlug}/${d.apiSlug ?? d.name}` : d.name);

export async function resolveDatabase(client: Client, workspaceId: string, ref: string): Promise<DatabaseRef> {
  const list = await listDatabases(client, workspaceId);
  const lower = ref.trim().toLowerCase();

  // ids and the canonical qualified `space/database` are always unambiguous.
  const byId = list.find((d) => d.id === ref);
  if (byId) return byId;
  const byQualified = list.find((d) => d.qualifiedSlug?.toLowerCase() === lower);
  if (byQualified) return byQualified;

  // `space/name` written with a display name instead of a slug.
  if (lower.includes('/')) {
    const [sp, db] = lower.split('/', 2);
    const inSpace = list.filter((d) => d.spaceSlug?.toLowerCase() === sp);
    const hit = inSpace.find((d) => d.apiSlug?.toLowerCase() === db || d.name.toLowerCase() === db);
    if (hit) return hit;
  }

  // Bare name or slug — MUST be unambiguous. Never silently pick the first (MN-153).
  const bare = list.filter(
    (d) => d.name.toLowerCase() === lower || d.apiSlug?.toLowerCase() === lower,
  );
  if (bare.length === 1) return bare[0]!;
  if (bare.length > 1) {
    throw new Error(
      `"${ref}" matches ${bare.length} databases. Use the qualified space/database form: ${bare.map(qualify).join(', ')}.`,
    );
  }

  const partial = list.filter((d) => d.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0]!;
  if (partial.length > 1) {
    throw new Error(`"${ref}" matches multiple databases: ${partial.map(qualify).join(', ')}. Be more specific (use space/database).`);
  }
  throw new Error(`No database matches "${ref}" in this workspace. Available: ${list.map(qualify).join(', ') || '(none)'}.`);
}
