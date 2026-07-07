import { sql } from 'drizzle-orm';
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  integer,
  jsonb,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * System schema — the schema-of-schemas lives in docs/architecture/meta-model.md.
 * This file grows ticket by ticket; MN-004 lands the tenancy layer.
 *
 * Note on user ids: better-auth (MN-006) owns the users table and uses text ids,
 * so every reference to a user is `text`, while our own resources use uuid.
 */

export * from './auth-schema';

export const membershipRole = pgEnum('membership_role', ['admin', 'member', 'guest']);
export const membershipStatus = pgEnum('membership_status', ['pending', 'active']);

export const fieldType = pgEnum('field_type', [
  'title',
  'text',
  'number',
  'checkbox',
  'date',
  'select',
  'multi_select',
  'url',
  'email',
  'user',
  'relation',
  'created_at',
  'updated_at',
  'created_by',
]);

export const viewType = pgEnum('view_type', ['table', 'board']);

/** Side "a" is the "many" side for one_to_many (meta-model §Relation). */
export const relationCardinality = pgEnum('relation_cardinality', ['one_to_many', 'many_to_many']);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  settings: jsonb('settings').notNull().default({}),
  ...timestamps,
});

export const spaces = pgTable('spaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  icon: text('icon'),
  position: integer('position').notNull().default(0),
  ...timestamps,
});

export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: membershipRole('role').notNull(),
    /** Guest scoping (ADR-0006). Null for admins/members. */
    spaceIds: uuid('space_ids').array(),
    status: membershipStatus('status').notNull().default('active'),
    invitedBy: text('invited_by'),
    ...timestamps,
  },
  (t) => [uniqueIndex('memberships_workspace_user_uq').on(t.workspaceId, t.userId)],
);

export const databases = pgTable(
  'databases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Denormalized from space for cheap workspace scoping on every query. */
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    icon: text('icon'),
    apiSlug: text('api_slug').notNull(),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('databases_workspace_slug_uq').on(t.workspaceId, t.apiSlug)],
);

export const fields = pgTable(
  'fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    databaseId: uuid('database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    /** Stable API identifier — survives display renames. */
    apiName: text('api_name').notNull(),
    type: fieldType('type').notNull(),
    config: jsonb('config').notNull().default({}),
    position: integer('position').notNull().default(0),
    isSystem: boolean('is_system').notNull().default(false),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('fields_database_api_name_uq').on(t.databaseId, t.apiName)],
);

export const selectOptions = pgTable('select_options', {
  id: uuid('id').primaryKey().defaultRandom(),
  fieldId: uuid('field_id')
    .notNull()
    .references(() => fields.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  color: text('color').notNull().default('gray'),
  position: integer('position').notNull().default(0),
  ...timestamps,
});

export const views = pgTable('views', {
  id: uuid('id').primaryKey().defaultRandom(),
  databaseId: uuid('database_id')
    .notNull()
    .references(() => databases.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  type: viewType('type').notNull(),
  config: jsonb('config').notNull().default({}),
  position: integer('position').notNull().default(0),
  createdBy: text('created_by'),
  ...timestamps,
});

export const records = pgTable(
  'records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    databaseId: uuid('database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    /** Title promoted to a real column (search, pickers, activity rendering). */
    title: text('title').notNull().default(''),
    /** User-defined values keyed by field UUID — ADR-0002. Relations live in record_links. */
    values: jsonb('values').notNull().default({}),
    /** Fractional-index rank, one per database (ADR-0005). */
    position: text('position').notNull().default('a0'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('records_values_gin').using('gin', sql`${t.values} jsonb_path_ops`),
    index('records_db_position_idx').on(t.databaseId, t.position),
    index('records_db_created_idx').on(t.databaseId, t.createdAt, t.id),
    index('records_title_trgm').using('gin', sql`${t.title} gin_trgm_ops`),
  ],
);

export const relations = pgTable('relations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  databaseAId: uuid('database_a_id')
    .notNull()
    .references(() => databases.id, { onDelete: 'cascade' }),
  databaseBId: uuid('database_b_id')
    .notNull()
    .references(() => databases.id, { onDelete: 'cascade' }),
  fieldAId: uuid('field_a_id').notNull(),
  fieldBId: uuid('field_b_id').notNull(),
  cardinality: relationCardinality('cardinality').notNull(),
  ...timestamps,
});

export const recordLinks = pgTable(
  'record_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    relationId: uuid('relation_id')
      .notNull()
      .references(() => relations.id, { onDelete: 'cascade' }),
    fromRecordId: uuid('from_record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    toRecordId: uuid('to_record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('record_links_uq').on(t.relationId, t.fromRecordId, t.toRecordId),
    index('record_links_from_idx').on(t.relationId, t.fromRecordId),
    index('record_links_to_idx').on(t.relationId, t.toRecordId),
  ],
);

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  recordId: uuid('record_id')
    .notNull()
    .unique()
    .references(() => records.id, { onDelete: 'cascade' }),
  /** BlockNote block array — schema-light by design (MN-024). */
  content: jsonb('content'),
  /** Extracted plain text (future workspace search). */
  contentText: text('content_text').notNull().default(''),
  /** Optimistic concurrency: PUT carries expected_version → 409 on mismatch. */
  version: integer('version').notNull().default(1),
  ...timestamps,
});

export const activityEvents = pgTable(
  'activity_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    recordId: uuid('record_id').references(() => records.id, { onDelete: 'cascade' }),
    actorId: text('actor_id'),
    /** Contract-grade type names — this table is the future webhook outbox (ADR-0004). */
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('activity_record_created_idx').on(t.recordId, t.createdAt)],
);

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: membershipRole('role').notNull(),
  spaceIds: uuid('space_ids').array(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  invitedBy: text('invited_by'),
  ...timestamps,
});
