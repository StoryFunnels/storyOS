import { z } from 'zod';

/**
 * An emoji, or a curated-set reference `set:<name>` (MN-208).
 *
 * #283: this only bounds length — it doesn't reject raw emoji. The invariant
 * that only `set:<name>` refs actually get persisted is enforced one layer
 * down, in DatabasesService.create/update (via `normalizeIconInput` from
 * `@storyos/schemas/icons`), because that's the only choke point every entry
 * point (HTTP API, templates, integrations) actually goes through — see the
 * comment on createSpaceSchema in ./workspaces.ts for the full reasoning.
 */
const iconValueSchema = z.string().max(48);

export const createDatabaseSchema = z.object({
  space_id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  icon: iconValueSchema.optional(),
});

export const databaseColorSchema = z.enum([
  'gray', 'brown', 'gold', 'orange', 'red', 'pink', 'purple', 'blue', 'teal', 'green',
]);

export const updateDatabaseSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  icon: iconValueSchema.nullable().optional(),
  color: databaseColorSchema.nullable().optional(),
  space_id: z.uuid().optional(),
  /** Sidebar folder (MN-096); null moves the database to the space root. */
  folder_id: z.uuid().nullable().optional(),
  position: z.number().int().optional(),
});

export const deleteDatabaseSchema = z.object({
  /** Must equal the database name — the API-level "type the name to delete". */
  confirm: z.string(),
  /** Required when other databases still point here via relations. */
  sever_relations: z.boolean().default(false),
});
