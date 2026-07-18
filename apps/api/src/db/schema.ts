import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
/**
 * The graded scope ladder (ADR-0007, extended by MN-121). `contributor` sits
 * between commenter and editor: read + create + update records, but NO delete.
 * It is also the billing boundary — see AccessService.isBillable.
 */
export const accessRole = pgEnum('access_role', [
  'viewer',
  'commenter',
  'contributor',
  'editor',
  'creator',
]);

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
  'color',
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

export const spaces = pgTable(
  'spaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** URL/API-safe handle, unique per workspace. Namespaces database slugs (MN-153). */
    slug: text('slug').notNull(),
    icon: text('icon'),
    color: text('color'),
    position: integer('position').notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex('spaces_workspace_slug_uq').on(t.workspaceId, t.slug)],
);

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
    /**
     * Exactly one of spaceId/databaseId — now enforced by a CHECK, not just the
     * service (MN-125). Highest grant wins.
     */
    spaceId: uuid('space_id').references(() => spaces.id, { onDelete: 'cascade' }),
    /**
     * MN-125: this had NO foreign key while spaceId did, so a grant survived its
     * database being deleted — a dangling row that could match a recycled id.
     */
    databaseId: uuid('database_id').references(() => databases.id, { onDelete: 'cascade' }),
    role: accessRole('role').notNull(),
    createdBy: text('created_by'),
    ...timestamps,
  },
  (t) => [
    index('access_grants_user_idx').on(t.workspaceId, t.userId),
    /**
     * MN-125: the upsert was a read-then-write with nothing backing it, so two
     * concurrent grants on the same scope produced duplicate rows. Reads took a
     * max and so failed safe — but deleteGrant removed only ONE row, meaning
     * revoking access reported success while access silently persisted. A
     * security control that says "done" and does nothing is the dangerous half.
     *
     * Partial indexes because exactly one column is non-null per row.
     */
    uniqueIndex('access_grants_user_space_uq')
      .on(t.userId, t.spaceId)
      .where(sql`${t.spaceId} IS NOT NULL`),
    uniqueIndex('access_grants_user_database_uq')
      .on(t.userId, t.databaseId)
      .where(sql`${t.databaseId} IS NOT NULL`),
    /** The scope XOR the service always claimed, now actually enforced. */
    check(
      'access_grants_scope_xor',
      sql`(${t.spaceId} IS NULL) <> (${t.databaseId} IS NULL)`,
    ),
  ],
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
  (t) => [uniqueIndex('databases_space_slug_uq').on(t.spaceId, t.apiSlug)],
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
  /** The view a database opens with; at most one true per database (MN-241). */
  isDefault: boolean('is_default').notNull().default(false),
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
  /**
   * Auto-link rules (MN-085): field-to-field match conditions that populate this
   * relation automatically. null = off. Shape: { conditions: [{ field_a_id,
   * field_b_id }], case_sensitive }. field ids are resolved + validated at save.
   */
  autoLink: jsonb('auto_link'),
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

/**
 * Record → record mentions (MN-205): a #mention written inside a record's document.
 * The backlink store — "which records mention this one" — indexed on the target so
 * the "Mentioned in" panel is a cheap reverse lookup. Distinct from record_links
 * (explicit relation fields); a mention is an ambient reference, not a schema edge.
 */
export const recordMentions = pgTable(
  'record_mentions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The record whose document contains the mention. */
    sourceRecordId: uuid('source_record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    /** The mentioned record. */
    targetRecordId: uuid('target_record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('record_mentions_uq').on(t.sourceRecordId, t.targetRecordId),
    index('record_mentions_target_idx').on(t.targetRecordId),
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

/**
 * MN-134: a token's power ceiling. read = look only; write = read + create/update/
 * delete records, links, comments, attachments, run buttons; admin = + schema
 * (databases, fields, relations, views) and everything else. Enforced server-side
 * on every request, so it holds even against a hand-crafted call.
 */
export const tokenScope = pgEnum('token_scope', ['read', 'write', 'admin']);

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
  /** Power ceiling (MN-134). Existing tokens default to admin, keeping their reach. */
  scope: tokenScope('scope').notNull().default('admin'),
  /** run_button is gateable separately within write scope (MN-134). */
  allowRunButton: boolean('allow_run_button').notNull().default(true),
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
    /**
     * MN-168: denormalized off automations->databases so the monthly-allowance
     * counter (usage_counters) never needs a 3-way join. Same pattern as
     * notifications/favorites/activity_events, which all carry workspace_id
     * directly for the same reason.
     */
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    triggerRecordId: uuid('trigger_record_id'),
    status: text('status').notNull(), // ok | error | skipped
    error: text('error'),
    effects: jsonb('effects'),
    depth: integer('depth').notNull().default(0),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('automation_runs_rule_idx').on(t.automationId, t.createdAt),
    index('automation_runs_workspace_idx').on(t.workspaceId, t.createdAt),
  ],
);

/**
 * MN-032: outgoing webhooks. ADR-0004 planned exactly this shape — subscriptions
 * plus a dispatcher over the `activity_events` outbox — so no schema rework was
 * needed: every mutation already writes a contract-named event in its own
 * transaction, and the dispatcher just reads them.
 */
export const webhookSubscriptions = pgTable(
  'webhook_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** null = every database in the workspace. */
    databaseId: uuid('database_id').references(() => databases.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    /** activity_events.type names to deliver, e.g. ["record.created"]. */
    events: jsonb('events').notNull().default([]),
    /** HMAC-SHA256 key for the X-StoryOS-Signature header. Never returned to a client. */
    secret: text('secret').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /**
     * Only events after this are delivered, so a new subscription never replays
     * history. Advances as the dispatcher scans.
     */
    cursorAt: timestamp('cursor_at', { withTimezone: true }).notNull().defaultNow(),
    /** Last-delivery status, denormalized for the settings list (AC: visible status). */
    lastStatus: text('last_status'), // ok | failed
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    lastDeliveredAt: timestamp('last_delivered_at', { withTimezone: true }),
    createdBy: text('created_by'),
    ...timestamps,
  },
  (t) => [index('webhook_subs_workspace_idx').on(t.workspaceId, t.enabled)],
);

/** One row per (subscription, event) attempt-set — the retry queue and the audit trail. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** null for a button's send_webhook action (MN-088) — it has a URL, not a subscription. */
    subscriptionId: uuid('subscription_id').references(() => webhookSubscriptions.id, {
      onDelete: 'cascade',
    }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Resolved target, kept on the row so the audit trail survives a URL edit. */
    url: text('url').notNull(),
    /** No FK: a delivery outlives its event, and button presses have no event row. */
    eventId: uuid('event_id'),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'), // pending | ok | failed
    attempts: integer('attempts').notNull().default(0),
    statusCode: integer('status_code'),
    error: text('error'),
    /** Backoff schedule; null once the delivery is settled. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('webhook_deliveries_sub_idx').on(t.subscriptionId, t.createdAt),
    index('webhook_deliveries_due_idx').on(t.status, t.nextAttemptAt),
    /**
     * At-most-once per (subscription, event), enforced by the db rather than by
     * cursor arithmetic: a rescan, a crash mid-pass, or two replicas scanning at
     * the same time must never double-deliver. NULL event_id (button webhooks)
     * is exempt — Postgres allows repeated NULLs in a unique index.
     */
    uniqueIndex('webhook_deliveries_sub_event_uq').on(t.subscriptionId, t.eventId),
  ],
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
    /** Archived out of the inbox (MN-073) — hidden from the default list, kept for history. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.workspaceId, t.readAt, t.createdAt)],
);

/** Per-user preferences blob (#30/#31): notification toggles now, regional
 * formats next. Keyed by better-auth user id (text; the user table lives in
 * auth-schema and isn't managed here, like notifications/favorites). */
export const userPreferences = pgTable('user_preferences', {
  userId: text('user_id').primaryKey(),
  preferences: jsonb('preferences').notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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

/**
 * MN-165 — billing spine. Stripe is the source of truth for money; these tables
 * are the local projection the app reads for entitlements (MN-168) so a hot path
 * never blocks on a Stripe round-trip. Webhooks (verified, idempotent) keep them
 * in sync; nothing here is authoritative over Stripe.
 *
 * Billing model (ADR-0014): ONE Stripe customer and ONE subscription per
 * workspace (1:1:1). Business billed per workspace = one $99 subscription each;
 * multi-workspace accounts simply have multiple customers. MN-191 may later
 * consolidate to a single customer with many subscriptions — the projection
 * below already tolerates that because the key is the workspace, not the customer.
 */
export const billingPlan = pgEnum('billing_plan', ['free', 'pro', 'business', 'enterprise']);

/** Mirrors Stripe's subscription.status verbatim so reconcile is a straight copy. */
export const subscriptionStatus = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'unpaid',
  'paused',
]);

/** workspace → Stripe customer. One row per workspace that has ever touched billing. */
export const billingCustomers = pgTable('billing_customers', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id').notNull().unique(),
  ...timestamps,
});

/**
 * The workspace's current plan state — the row MN-168 reads to gate scale. A
 * workspace with no row is Free by definition; a row exists once it trials or
 * subscribes. `plan`/`status` are driven only by verified webhooks + reconcile.
 */
export const billingSubscriptions = pgTable('billing_subscriptions', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  plan: billingPlan('plan').notNull().default('free'),
  /** null until a Stripe subscription exists (a no-card trial has none yet). */
  status: subscriptionStatus('status'),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  /** Billable seats charged as the $12 overage line — 0 while within the included tier. */
  seats: integer('seats').notNull().default(0),
  cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  /** Set for the 30-day no-card Pro trial (MN-192); drives auto-downgrade to Free. */
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  ...timestamps,
});

/**
 * Idempotency ledger for webhook delivery. Stripe re-sends events; a handler must
 * run at most once per event id. We claim the id here in the same breath as
 * applying the change — a duplicate delivery finds the row and no-ops.
 */
export const billingEvents = pgTable('billing_events', {
  /** Stripe event id (evt_…) — the idempotency key. */
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * MN-168 — durable, increment-on-write metering. One row per
 * (workspace, calendar month, metric); `count` only ever goes up via an
 * atomic upsert. Deliberately NOT a live COUNT over automation_runs / agent
 * Runs: increment-on-write means the "your-own-AI is never metered" guarantee
 * is structural — the only call sites that increment this table are gated on
 * `runClass === 'non_ai'`, so a your-own-AI or StoryOS-AI run has literally no
 * code path that reaches it (EntitlementsService.recordNonAiRun).
 *
 * `metric` stays a free-form key (only 'automation_runs' is written today) so
 * a future metered line reuses this table rather than growing a sibling one.
 */
export const usageCounters = pgTable(
  'usage_counters',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** First-of-month, UTC — the natural monthly reset with no cron needed. */
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    metric: text('metric').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('usage_counters_uq').on(t.workspaceId, t.periodStart, t.metric),
  ],
);
