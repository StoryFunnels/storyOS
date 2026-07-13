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

/** Graded scope access for guests (ADR-0007, connected-data model). */
export const accessRole = pgEnum('access_role', ['viewer', 'commenter', 'editor', 'creator']);

export const fieldType = pgEnum('field_type', [
  'id',
  'title',
  'text',
  'rich_text',
  'number',
  'checkbox',
  'date',
  'select',
  'multi_select',
  'url',
  'email',
  'user',
  'relation',
  'lookup',
  'rollup',
  'button',
  'formula',
  'created_at',
  'updated_at',
  'created_by',
]);

export const viewType = pgEnum('view_type', [
  'table', 'board', 'calendar', 'gallery', 'list', 'feed', 'timeline', 'form',
]);

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
  color: text('color'),
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
    status: membershipStatus('status').notNull().default('active'),
    invitedBy: text('invited_by'),
    ...timestamps,
  },
  (t) => [uniqueIndex('memberships_workspace_user_uq').on(t.workspaceId, t.userId)],
);

export const accessGrants = pgTable(
  'access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    /** Exactly one of spaceId/databaseId (service-enforced). Highest grant wins. */
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    databaseId: uuid('database_id'),
    role: accessRole('role').notNull(),
    createdBy: text('created_by'),
    ...timestamps,
  },
  (t) => [index('access_grants_user_idx').on(t.workspaceId, t.userId)],
);

/** Named collapsible containers inside a space, for sidebar IA (MN-096). */
export const spaceFolders = pgTable('space_folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  spaceId: uuid('space_id')
    .notNull()
    .references(() => spaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  icon: text('icon'),
  position: integer('position').notNull().default(0),
  ...timestamps,
});

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
    /** Optional sidebar folder (MN-096); null = at the space root. */
    folderId: uuid('folder_id').references(() => spaceFolders.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    icon: text('icon'),
    color: text('color'),
    apiSlug: text('api_slug').notNull(),
    position: integer('position').notNull().default(0),
    /** Allocator for per-database sequential public record numbers (MN-087). */
    recordCounter: integer('record_counter').notNull().default(0),
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
    /** Per-database sequential public id (MN-087) — the human handle in URLs. */
    number: integer('number'),
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
    uniqueIndex('records_db_number_uq').on(t.databaseId, t.number),
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

/** Standalone rich docs living in a space, independent of any record (MN-095). */
export const spaceDocuments = pgTable(
  'space_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    spaceId: uuid('space_id')
      .notNull()
      .references(() => spaces.id, { onDelete: 'cascade' }),
    /** Optional sidebar folder (MN-096); null = at the space root. */
    folderId: uuid('folder_id').references(() => spaceFolders.id, { onDelete: 'set null' }),
    title: text('title').notNull().default(''),
    icon: text('icon'),
    content: jsonb('content'),
    contentText: text('content_text').notNull().default(''),
    version: integer('version').notNull().default(1),
    position: integer('position').notNull().default(0),
    createdBy: text('created_by'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('space_documents_space_idx').on(t.spaceId)],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull(),
    /** Segments: [{type:'text',text} | {type:'mention',user_id}] — validated server-side. */
    body: jsonb('body').notNull(),
    /** Extracted server-side from body, never trusted from the client (D4). */
    mentions: text('mentions').array().notNull().default([]),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('comments_record_created_idx').on(t.recordId, t.createdAt)],
);

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  /** mn_pat_ + first 4 chars — the only recoverable fragment (E1). */
  tokenPrefix: text('token_prefix').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ...timestamps,
});

export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    size: integer('size').notNull(),
    mime: text('mime').notNull(),
    storageKey: text('storage_key').notNull(),
    /** Image-only thumbnail (MN-029 — no other previews by design). */
    thumbKey: text('thumb_key'),
    uploadedBy: text('uploaded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('attachments_record_idx').on(t.recordId, t.createdAt)],
);

/** Workspace-scoped uploads for rich-text editors (MN-097) — images embedded in
 * descriptions / documents. Served by unguessable id (capability URL). */
export const workspaceFiles = pgTable('workspace_files', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull().default(''),
  mime: text('mime').notNull(),
  size: integer('size').notNull().default(0),
  storageKey: text('storage_key').notNull(),
  uploadedBy: text('uploaded_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** MN-047: automation rules + run log. */
export const automations = pgTable(
  'automations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    databaseId: uuid('database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    trigger: jsonb('trigger').notNull(),
    condition: jsonb('condition'),
    actions: jsonb('actions').notNull(),
    failureStreak: integer('failure_streak').notNull().default(0),
    nextDueAt: timestamp('next_due_at', { withTimezone: true }),
    createdBy: text('created_by'),
    ...timestamps,
  },
  (t) => [index('automations_database_idx').on(t.databaseId, t.enabled)],
);

export const automationRuns = pgTable(
  'automation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    automationId: uuid('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    triggerRecordId: uuid('trigger_record_id'),
    status: text('status').notNull(), // ok | error | skipped
    error: text('error'),
    effects: jsonb('effects'),
    depth: integer('depth').notNull().default(0),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('automation_runs_rule_idx').on(t.automationId, t.createdAt)],
);

/** MN-049: per-user notification stream (assigned / mentioned / commented). */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    databaseId: uuid('database_id').references(() => databases.id, { onDelete: 'cascade' }),
    recordId: uuid('record_id').references(() => records.id, { onDelete: 'cascade' }),
    actorId: text('actor_id'),
    type: text('type').notNull(),
    snippet: text('snippet'),
    count: integer('count').notNull().default(1),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.workspaceId, t.readAt, t.createdAt)],
);

/** Per-user stars on a record or database, surfaced in the sidebar (MN-075). */
export const favorites = pgTable(
  'favorites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    targetType: text('target_type').notNull(), // 'record' | 'database'
    targetId: uuid('target_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('favorites_uq').on(t.userId, t.targetType, t.targetId),
    index('favorites_user_idx').on(t.userId, t.workspaceId),
  ],
);

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
  /** For guests: [{space_id|database_id, role}] — becomes access_grants on accept. */
  grants: jsonb('grants'),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  invitedBy: text('invited_by'),
  ...timestamps,
});
