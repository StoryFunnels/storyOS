import { z } from 'zod';

export const createDatabaseSchema = z.object({
  space_id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  icon: z.string().max(16).optional(),
});

export const updateDatabaseSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  icon: z.string().max(16).nullable().optional(),
  space_id: z.uuid().optional(),
  position: z.number().int().optional(),
});

export const deleteDatabaseSchema = z.object({
  /** Must equal the database name — the API-level "type the name to delete". */
  confirm: z.string(),
  /** Required when other databases still point here via relations. */
  sever_relations: z.boolean().default(false),
});
