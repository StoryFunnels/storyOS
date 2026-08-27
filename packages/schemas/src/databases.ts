import { z } from 'zod';
import { PALETTE } from './colors';
import { descriptionPatchSchema, descriptionSchema } from './descriptions';

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

/**
 * #399 — DERIVED. This was a hardcoded copy of the option palette's first ten,
 * and the five it was missing had been added to the other list only. A database
 * can now take any colour a select option can.
 */
export const databaseColorSchema = z.enum(PALETTE);

export const createDatabaseSchema = z.object({
  space_id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  icon: iconValueSchema.optional(),
  /** MN-299: explicit override; DatabasesService.create() auto-assigns a
   * random palette color when this is omitted. */
  color: databaseColorSchema.optional(),
  /**
   * #400 — a one-line "what belongs in this table".
   *
   * NOT the same thing as `description_hidden`/`description_order` below, which
   * configure the RECORD description block (#310) — a versioned document that
   * renders on each record's page. This is the DATABASE's own purpose line. The
   * two live side by side and are easy to confuse; they share nothing.
   */
  description: descriptionSchema,
});

export const updateDatabaseSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  icon: iconValueSchema.nullable().optional(),
  color: databaseColorSchema.nullable().optional(),
  space_id: z.uuid().optional(),
  /** Sidebar folder (MN-096); null moves the database to the space root. */
  folder_id: z.uuid().nullable().optional(),
  position: z.number().int().optional(),
  /** #400 — the DATABASE's own purpose line; null clears it. Not the record
   *  description block configured by the two keys below (#310). */
  description: descriptionPatchSchema,
  /**
   * #310 — the record description as a positioned, optional element. It is a
   * versioned `documents` row rather than a field, so it has no field config to
   * carry these; they live on the database because both are schema decisions.
   */
  description_hidden: z.boolean().optional(),
  /** null = the historical position (after all body fields). */
  description_order: z.number().int().nullable().optional(),
});

export const deleteDatabaseSchema = z.object({
  /** Must equal the database name — the API-level "type the name to delete". */
  confirm: z.string(),
  /** Required when other databases still point here via relations. */
  sever_relations: z.boolean().default(false),
});
