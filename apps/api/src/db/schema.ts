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
    /**
     * MN-260: materialized computed-field values, keyed by field UUID like
     * `values` but written only by the server (formula recompute-on-write) —
     * never by client input, so it can't drift from what validateRecordValues
     * allows. Exists so fieldExpr()/the keyset-cursor ORDER BY can sort by a
     * formula the same way as any stored field, instead of the value only
     * existing after attachFormulas() runs on an already-paginated page.
     * Rollup is NOT materialized here yet — see docs/architecture/record-storage.md.
     */
    computedValues: jsonb('computed_values').notNull().default({}),
    /** Fractional-index rank, one per database (ADR-0005). */
    position: text('position').notNull().default('a0'),
    createdBy: text('created_by'),
    updatedBy: text('updated_by'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('records_values_gin').using('gin', sql`${t.values} jsonb_path_ops`),
    index('records_computed_values_gin').using('gin', sql`${t.computedValues} jsonb_path_ops`),
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
 * descriptions / documents. Served by unguessable id (capability URL) for inline
 * embeds; downloads go through a signed, expiring URL instead (#201). */
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
  /** #201: an operator/owner revoke. Set (not cleared) — once revoked, both the
   * capability URL and any previously-minted signed download URL stop working;
   * there is no un-revoke. Checked on every read path (inline serve + signed
   * download), independent of signature/expiry validity. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
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
    /**
     * MN-254: inbound webhook identity, set only while trigger.type is
     * 'webhook_received' (minted on create/update, rotated by regenerate-hook,
     * cleared if the rule's trigger changes to something else). hookToken is
     * unique so the public receiver can resolve a delivery with one indexed
     * lookup; hookSecret signs the optional HMAC.
     */
    hookToken: text('hook_token').unique(),
    hookSecret: text('hook_secret'),
    lastHookPayload: jsonb('last_hook_payload'),
    lastHookAt: timestamp('last_hook_at', { withTimezone: true }),
    /** MN-255: per-rule override of who approves a gated action this rule fires.
     * Defaults to `createdBy` (the rule owner) when null — see
     * ApprovalsService.approverFor(). */
    approverId: text('approver_id'),
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
    /** MN-255: a loose (no FK — the referent varies by `type`) pointer to the
     * entity a notification is actionable against, when that isn't `recordId`
     * itself. `action_approval_requested` sets this to `approvals.id`, since
     * the triggering record (`recordId`, shown for context) and the thing the
     * Inbox card actually approves/rejects (this) are different rows. */
    refId: text('ref_id'),
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

/**
 * Record versioning (MN-231, layer 3 of the durability plan — extends the
 * MN-027 activity trail from "view the diff" to "restore the snapshot").
 * One row per record write that changes stored data: the FULL prior
 * values/title, captured before the write lands, so a restore never has to
 * replay/reconstruct state from a chain of diffs. Same cascade shape as
 * activity_events; no retention/pruning job yet (deferred — see MN-231
 * ticket comment).
 */
export const recordVersions = pgTable(
  'record_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id, { onDelete: 'cascade' }),
    actorId: text('actor_id'),
    title: text('title').notNull(),
    values: jsonb('values').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('record_versions_record_created_idx').on(t.recordId, t.createdAt)],
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
  /**
   * Dedup markers for the day-23/day-29 proactive trial-expiry reminders
   * (#263). One row per workspace already carries `trialEndsAt`, so a
   * nullable timestamp per milestone here is the natural home for the
   * claim — no separate log table needed. TrialRemindersService claims a
   * milestone with an atomic `UPDATE ... WHERE <column> IS NULL RETURNING`
   * before sending anything, the same claim-then-act shape `billingEvents`
   * uses for webhook ids, so a duplicate/overlapping sweep tick is a no-op.
   */
  trialReminder23SentAt: timestamp('trial_reminder_23_sent_at', { withTimezone: true }),
  trialReminder29SentAt: timestamp('trial_reminder_29_sent_at', { withTimezone: true }),
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
 * `metric` stays a free-form key so a new metered line (or, per MN-195, an
 * unbilled abuse-detection counter on a different period granularity —
 * `periodStart` is just "start of the current bucket", not necessarily a
 * calendar month) reuses this table rather than growing a sibling one.
 */
export const usageCounters = pgTable(
  'usage_counters',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Start of the counting bucket — first-of-month for billing metrics
     * (MN-168), start-of-hour for abuse-detection ones (MN-195). */
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    metric: text('metric').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [
    uniqueIndex('usage_counters_uq').on(t.workspaceId, t.periodStart, t.metric),
  ],
);

/**
 * MN-189 — StoryOS AI prepaid credits. Modeled as a balance (this table) plus
 * an append-only ledger (aiCreditTransactions) — NOT a subscription line
 * (ADR-0014's per-workspace subscription is the plan; this is orthogonal and
 * exists independent of plan/cancellation, matching "the AI add-on is
 * available on any plan"). All money here is in CENTS, matching Stripe.
 */
export const aiCreditBalances = pgTable('ai_credit_balances', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  balanceCents: integer('balance_cents').notNull().default(0),
  autoReloadEnabled: boolean('auto_reload_enabled').notNull().default(false),
  /** Trigger a reload when balance drops to/below this. */
  autoReloadThresholdCents: integer('auto_reload_threshold_cents'),
  /** How much to add when auto-reload fires. */
  autoReloadAmountCents: integer('auto_reload_amount_cents'),
  /**
   * MN-189 follow-up (#265) — the off-session charge mutex. Set (claimed) the
   * moment a threshold-crossing attempt starts, cleared the moment it
   * concludes (success or failure). The claim is an atomic
   * `UPDATE ... WHERE auto_reload_claimed_at IS NULL` (same shape as
   * TrialRemindersService's sentAt columns), so two `recordUsage()` calls
   * crossing the threshold in the same instant can never both win it —
   * exactly one proceeds to call Stripe.
   */
  autoReloadClaimedAt: timestamp('auto_reload_claimed_at', { withTimezone: true }),
  /** Consecutive off-session charge failures since the last success. Reset to
   * 0 on a successful reload; drives the retry backoff and the eventual
   * auto-disable (see AiCreditsService.AUTO_RELOAD_MAX_ATTEMPTS). */
  autoReloadFailureCount: integer('auto_reload_failure_count').notNull().default(0),
  /** Earliest time AutoReloadRetryService's sweep (or a future usage event)
   * may retry a failed reload. NULL means no retry is pending — either
   * nothing has failed, or retries were exhausted and auto-reload was
   * disabled. */
  autoReloadNextRetryAt: timestamp('auto_reload_next_retry_at', { withTimezone: true }),
  ...timestamps,
});

export const aiCreditTransactionType = pgEnum('ai_credit_transaction_type', [
  'top_up',
  'usage',
  'refund',
  'adjustment',
]);

/**
 * One row per balance-changing event — top-ups are positive, usage is
 * negative. `tokensIn`/`tokensOut`/`ourCostCents` are only set on `usage`
 * rows (per-run cost attribution, MN-188's other half); `stripePaymentIntentId`
 * only on `top_up` (idempotency key — see AiCreditsService.applyTopUp).
 *
 * `expiresAt`/`remainingCents` (MN-189 follow-up, #265): credits expire 12
 * months after purchase (MN-189's original proposal — implemented rather than
 * left perpetual, since this is greenfield with no production balances yet).
 * Only ever set on `top_up` rows — `remainingCents` starts equal to
 * `amountCents` and is decremented FIFO (oldest top-up first) as usage
 * consumes it, in the same transaction as the debit
 * (AiCreditsService.recordUsage). `expiresAt` is checked lazily — at
 * getBalance()/recordUsage() time, not via a cron sweep — the simplest
 * correct option given this ledger has no scheduled-sweep infra of its own
 * yet: any top-up past its expiry with `remainingCents > 0` gets that
 * remainder forfeited (an `adjustment` ledger row records the forfeiture) the
 * next time the balance is touched.
 */
export const aiCreditTransactions = pgTable(
  'ai_credit_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: aiCreditTransactionType('type').notNull(),
    /** Signed: positive credits the balance, negative debits it. */
    amountCents: integer('amount_cents').notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    ourCostCents: integer('our_cost_cents'),
    stripePaymentIntentId: text('stripe_payment_intent_id').unique(),
    /** `top_up` rows only: 12 months after `createdAt`. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** `top_up` rows only: starts at `amountCents`, FIFO-decremented by usage,
     * zeroed by lazy expiry once `expiresAt` passes. */
    remainingCents: integer('remaining_cents'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_credit_transactions_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/**
 * MN-195 — fair-use guard. NOT a cap, NOT a throttle: "no record limits,
 * ever" is a headline promise, so this only ever FLAGS a workspace whose
 * write rate looks like abuse (scraping, dump, free-database-backend use) for
 * a human to review case-by-case — it never blocks or slows a single write.
 * One row per (workspace, metric, hour) that crossed the threshold — the
 * unique constraint is what makes flagging idempotent within an hour even if
 * checked on every write in a burst.
 */
export const abuseFlags = pgTable(
  'abuse_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    metric: text('metric').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    /** The count that crossed the line, and the line itself — both logged so
     * a human reviewing later sees exactly how far over it went. */
    value: integer('value').notNull(),
    threshold: integer('threshold').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('abuse_flags_workspace_metric_window_uq').on(t.workspaceId, t.metric, t.windowStart)],
);

/**
 * MN-196 — per-workspace entitlement overrides, the delivery mechanism for
 * Enterprise contracts, comps, grandfathering, and temporary support grants.
 * One row per workspace (upsert on set); each field is independently
 * nullable — null means "no override, fall through to the plan default"
 * (EntitlementsService.getLimits() / canCreateWorkspace()). MN-104's admin
 * panel is the intended write surface; this ships the data model +
 * resolution logic it will call into.
 */
export const workspaceEntitlementOverrides = pgTable('workspace_entitlement_overrides', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  includedSeats: integer('included_seats'),
  automationRunsPerMonth: integer('automation_runs_per_month'),
  maxWorkspaces: integer('max_workspaces'),
  /** e.g. {"sso": true, "auditLog": true, "prioritySupport": true} — record-keeping today; nothing enforces individual flags yet. */
  featureFlags: jsonb('feature_flags'),
  reason: text('reason').notNull(),
  /** null = never expires. Lazy check-on-read (same pattern as MN-192's trial sweep) ignores an expired override without deleting the row — the audit trail stays intact. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  ...timestamps,
});

export const entitlementOverrideEventAction = pgEnum('entitlement_override_event_action', [
  'set',
  'clear',
]);

/**
 * Append-only audit trail — "every override change is audit-logged" (MN-196
 * AC). Never updated or deleted; the override row above always reflects only
 * the CURRENT state, this table is the history of how it got there.
 */
export const entitlementOverrideEvents = pgTable(
  'entitlement_override_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    actorUserId: text('actor_user_id').notNull(),
    action: entitlementOverrideEventAction('action').notNull(),
    /** Full override field snapshot at the time of this event. */
    snapshot: jsonb('snapshot').notNull(),
    reason: text('reason').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('entitlement_override_events_workspace_idx').on(t.workspaceId, t.createdAt)],
);

/**
 * MN-104 — the instance operator flag. NOT a column on `user`: better-auth
 * owns that table (see auth-schema.ts's own comment) and app columns don't
 * belong on it. Presence of a row = platform admin; this is a small,
 * append-and-delete table, not a boolean anyone flips on a user record.
 * `grantedBy` is null for the env-seeded first operator (nobody granted it —
 * it came from PLATFORM_ADMIN_EMAIL at boot).
 */
export const platformAdmins = pgTable('platform_admins', {
  userId: text('user_id').primaryKey(),
  grantedBy: text('granted_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * MN-252 — the workspace credential registry. One row per connected external
 * provider (Apify, Resend, and — once the follow-up tickets land their own
 * descriptors — LinkedIn/Meta/YouTube via OAuth2). Replaces the ad-hoc
 * plaintext `workspaces.settings.{slack,linear,github}` blobs for anything
 * new; those three keep working as-is (migrating them is an explicit
 * non-goal here).
 *
 * `authSealed` is the secretbox (apps/api/src/common/secretbox.ts) ciphertext
 * of the provider's auth JSON (an API key, or an OAuth token pair) — the
 * plaintext is never stored, logged, or returned by any endpoint.
 * `errorStreak`/`breakerOpenUntil` are pre-provisioned columns for MN-253's
 * circuit breaker; nothing writes `breakerOpenUntil` yet.
 */
export const connectionStatus = pgEnum('connection_status', [
  'active',
  'expired',
  'revoked',
  'error',
]);

export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Provider descriptor id (providers/index.ts registry key) — e.g. "apify". */
    provider: text('provider').notNull(),
    /** Admin-chosen display name, distinguishing multiple connections to one provider. */
    name: text('name').notNull(),
    /** secretbox ciphertext of the auth JSON — never the plaintext. */
    authSealed: text('auth_sealed').notNull(),
    /** OAuth scopes actually granted; [] for api_key/smtp providers. */
    scopes: jsonb('scopes').notNull().default([]),
    status: connectionStatus('status').notNull().default('active'),
    lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
    errorStreak: integer('error_streak').notNull().default(0),
    /** Pre-provisioned for MN-253's circuit breaker — unused until then. */
    breakerOpenUntil: timestamp('breaker_open_until', { withTimezone: true }),
    /**
     * MN-253 — per-connection token-bucket state (common/token-bucket.ts),
     * `{ tokens: number, lastRefillAt: string }`. Null until the first job
     * runs against this connection; JobRunnerService seeds it from the
     * provider descriptor's `rateLimit` default on first use.
     */
    connectionRateState: jsonb('connection_rate_state'),
    /**
     * #239 — daily API-quota budget for read-heavy sources (YouTube: 1 unit/
     * call). Shape: `{ date: 'YYYY-MM-DD', used: number }`, reset whenever
     * `date` rolls over. Nullable — untouched by connections that never back
     * a source. Scoped separately from `connectionRateState` above: that one
     * is MN-253's action-execution token bucket (retry/circuit-breaker
     * concern); this is a same-day usage ceiling for scheduled polling, a
     * different failure mode (silently blowing a provider's daily cap) with a
     * different owner (SourcesService).
     */
    quotaState: jsonb('quota_state'),
    createdBy: text('created_by'),
    ...timestamps,
  },
  (t) => [index('connections_workspace_provider_idx').on(t.workspaceId, t.provider)],
);

/**
 * Cached GitHub PR review (inline) comments (#43) — the local half of the
 * bi-directional sync: outbound writes POST to GitHub first and cache the
 * result here; inbound arrives via the `pull_request_review_comment` webhook
 * event or the manual re-sync poll. GitHub, not this table, is the source of
 * truth — a row here is a read cache, never the only copy of a comment.
 *
 * `commentId`/`inReplyToId` are `text`: GitHub comment ids are int64, past
 * JS's safe-integer range. Unique on (workspaceId, commentId) so a webhook
 * redelivery or a re-poll upserts instead of duplicating.
 */
export const githubReviewComments = pgTable(
  'github_review_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** "owner/name". */
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    /** GitHub's review-comment id. */
    commentId: text('comment_id').notNull(),
    /** The thread parent's GitHub comment id, null for a thread's first comment. */
    inReplyToId: text('in_reply_to_id'),
    /** Null for a reply (GitHub's reply payload omits path/line; it belongs to the parent's anchor). */
    path: text('path'),
    line: integer('line'),
    side: text('side'),
    diffHunk: text('diff_hunk'),
    authorLogin: text('author_login'),
    body: text('body').notNull(),
    /** content → count, refreshed on read/react — a cache, not a ledger. */
    reactions: jsonb('reactions').notNull().default({}),
    githubCreatedAt: timestamp('github_created_at', { withTimezone: true }),
    githubUpdatedAt: timestamp('github_updated_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('github_review_comments_workspace_comment_uq').on(t.workspaceId, t.commentId),
    index('github_review_comments_pr_idx').on(t.workspaceId, t.repo, t.prNumber),
  ],
);

/**
 * #33 — the cloud referral program. One row per user who has ever generated
 * a link; the code is the public, shareable identifier (never the user id).
 * Gated at the API layer by `StripeService.enabled` (StripeService is the
 * existing cloud-vs-self-host signal — MN-166's `enabled` flag; no separate
 * CLOUD_MODE flag exists in this codebase and none is added here), same as
 * Billing. No FK to `user` — every other user-id column in this schema
 * (memberships.userId, connections.createdBy, …) is a bare text id, since
 * better-auth (not drizzle) owns that table.
 */
export const referralCodes = pgTable('referral_codes', {
  userId: text('user_id').primaryKey(),
  code: text('code').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per successfully-attributed referred sign-up — first-touch,
 * one-time: `refereeUserId` is unique so a user can only ever be credited to
 * the one referrer whose link/cookie got there first, and re-attributing is a
 * no-op (ReferralsService.attribute uses onConflictDoNothing on this
 * uniqueness). `convertedAt` flips once, the first time ANY workspace this
 * referee admins upgrades off Free (BillingService.reconcileSubscription
 * calls ReferralsService.recordConversionIfEligible) — never re-armed, so a
 * downgrade-then-upgrade cycle can't be farmed for a second reward.
 */
export const referralSignups = pgTable(
  'referral_signups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    referrerUserId: text('referrer_user_id').notNull(),
    refereeUserId: text('referee_user_id').notNull(),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('referral_signups_referee_uq').on(t.refereeUserId),
    index('referral_signups_referrer_idx').on(t.referrerUserId),
  ],
);

/**
 * MN-253 — the durable action-job queue. One row per external-action attempt
 * chain: `actions.service.ts`'s execute() enqueues a row here instead of
 * running an external action kind (send_email, post_social.*, http_request,
 * youtube_upload — added by MN-256/257/258/259/263) inline, and
 * JobRunnerService's claim loop (SKIP LOCKED) runs it with backoff retries.
 *
 * `idempotencyKey` is UNIQUE — enqueue() does `INSERT … ON CONFLICT DO
 * NOTHING`, so a duplicate enqueue call for the same rule/record/run/action
 * index never creates a second row; it returns the existing one instead.
 *
 * `connectionId` is nullable (SET NULL) so deleting a connection never loses
 * job history, but is set whenever a job targets one — it's what the claim
 * loop joins against for the per-connection circuit breaker and rate limit.
 *
 * `ruleId` is SET NULL (not cascade) so a job that already ran keeps its
 * history if the owning rule is later deleted.
 */
export const automationJobs = pgTable(
  'automation_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id').references(() => automations.id, { onDelete: 'set null' }),
    /** MN-255 fix: intentionally NOT a FK. `runId` is minted by
     * AutomationsService BEFORE the automation_runs row exists — `runRule()`/
     * `runHookRule()` pass the pre-minted id into `actions.execute()` and only
     * INSERT automation_runs afterward, once execute() returns (see
     * automations.service.ts's own comment: "actions.execute() needs it
     * before the run row exists"). A hard FK here would make enqueue() throw
     * a foreign-key violation for exactly the case it exists to support — a
     * job (or, discovered via MN-255, an approval) created mid-execute(). A
     * dangling runId (the automation_runs insert never happens, e.g. a crash)
     * is a harmless orphan reference, not a correctness problem. */
    runId: uuid('run_id'),
    connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
    /** MN-255: set only when this job was enqueued by ApprovalsService.approve()
     * — lets JobRunnerService post a follow-up "executed"/"failed" comment on
     * the triggering record once the job settles. SET NULL, not cascade: a
     * job that already ran keeps its history if the approval row is pruned. */
    approvalId: uuid('approval_id').references(() => approvals.id, { onDelete: 'set null' }),
    actionIndex: integer('action_index').notNull(),
    /** e.g. 'send_email', 'post_social.linkedin' — the executor registry key. */
    kind: text('kind').notNull(),
    /** FROZEN at enqueue: rendered action config + { workspaceId, databaseId, recordId, actorId }. */
    payload: jsonb('payload').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** queued | running | succeeded | failed | canceled */
    status: text('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** short (30s) | long (15min) | upload (60min) — see common/backoff-schedule.ts. */
    timeoutClass: text('timeout_class').notNull().default('short'),
    /** Set when claimed; the reaper reverts a job stuck 'running' past its
     * timeoutClass duration back to 'queued' so an API restart never loses it. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    /** Redacted (common/redact-secrets.ts) + truncated to 8KB. */
    lastError: text('last_error'),
    /** Redacted provider response + artifact id, whatever the executor returns. */
    artifact: jsonb('artifact'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('automation_jobs_idempotency_key_idx').on(t.idempotencyKey),
    index('automation_jobs_claim_idx').on(t.status, t.nextAttemptAt),
    index('automation_jobs_connection_idx').on(t.connectionId),
  ],
);

/**
 * MN-255 — the approval gate. A `require_approval` action stops here instead
 * of running: `actionSnapshot` is the FULLY RENDERED action (every {Field}/
 * {payload} token already interpolated, at request time — see
 * actions.service.ts's `execute()`) so a record edit between "queued for
 * approval" and "approved" can never change what eventually runs. `runId` is
 * SET NULL (not cascade) for the same reason `automationJobs.ruleId` is: an
 * approval that already resolved keeps its history if the run row is later
 * pruned. `ruleId` likewise SET NULL if the rule itself is deleted.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id').references(() => automations.id, { onDelete: 'set null' }),
    /** Not a FK — see `automationJobs.runId`'s comment: this row is inserted
     * BY `actions.service.ts execute()`, which runs strictly before
     * `runRule()`/`runHookRule()` insert the automation_runs row for this
     * same `runId`. A hard FK would 500 on every gated action. */
    runId: uuid('run_id'),
    recordId: uuid('record_id'),
    actionIndex: integer('action_index').notNull(),
    /** FROZEN rendered action — see module doc above. */
    actionSnapshot: jsonb('action_snapshot').notNull(),
    /** Human-readable summary for the Inbox card. */
    previewText: text('preview_text').notNull(),
    /** pending | approved | rejected | expired */
    status: text('status').notNull().default('pending'),
    /** Who must decide. Defaults to the rule's createdBy at insert time —
     * see ApprovalsService.approverFor() — with `automations.approverId` as
     * a per-rule override. */
    approverId: text('approver_id'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    reason: text('reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
    ...timestamps,
  },
  (t) => [index('approvals_workspace_status_expiry_idx').on(t.workspaceId, t.status, t.expiresAt)],
);

/** Personal vs team-shared (#40 AC #1): 'personal' is visible only to its
 * owner, 'shared' to every active member of the workspace. There is no
 * separate teams table yet, so "team-shared" today means "workspace-shared" —
 * the same granularity `connections`/`automations` already use for
 * workspace-wide config. */
export const skillVisibility = pgEnum('skill_visibility', ['personal', 'shared']);

/**
 * #40 — the Skills framework: named, reusable instruction+workflow bundles for
 * the StoryOS agent. Deliberately its own table rather than a provisioned
 * "pack" database (contrast AgentsService.ensurePack): a skill is portable,
 * hand-authored prose meant to round-trip through Markdown/SKILL.md/ChatGPT
 * export, not a schema of typed fields a person would browse as records.
 *
 * `lastRun*` is bookkeeping for the manual-run surface (ADR-0010 §3's runtime
 * seam, reused rather than duplicated — see skills.service.ts) — a skill run
 * is ad hoc and synchronous, so it has no Run record of its own to read this
 * off of the way an agent run does.
 */
export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The author — always set, regardless of visibility (better-auth id, text). */
    ownerId: text('owner_id').notNull(),
    visibility: skillVisibility('visibility').notNull().default('personal'),
    name: text('name').notNull(),
    description: text('description').notNull(),
    whenToUse: text('when_to_use').notNull(),
    instructions: text('instructions').notNull(),
    /** Array of { input, output } — see skillExampleSchema. */
    examples: jsonb('examples').notNull().default([]),
    /** Tool identifiers the skill may use when run (#41's future MCP allowlist
     * reads straight off this column — see skills.service.ts's header note). */
    allowedTools: jsonb('allowed_tools').notNull().default([]),
    /** Which SKILL_TEMPLATES scaffold this was authored from, `'chat'` once #39
     * lands, or null for a from-scratch skill. Provenance only. */
    sourceTemplate: text('source_template'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunStatus: text('last_run_status'), // 'ok' | 'error'
    lastRunSteps: jsonb('last_run_steps'),
    ...timestamps,
  },
  (t) => [
    index('skills_workspace_visibility_idx').on(t.workspaceId, t.visibility),
    index('skills_owner_idx').on(t.workspaceId, t.ownerId),
  ],
);

/** What kind of live object a `pack_install_items` row tracks (MN-219 / #161). */
export const packInstallItemKind = pgEnum('pack_install_item_kind', [
  'database',
  'field',
  'relation',
  'state',
  'agent',
  'trigger',
  'derived_field',
  'view',
  'automation',
  'sample_record',
  'skill',
]);
export const packInstallItemAction = pgEnum('pack_install_item_action', ['created', 'reused']);

/**
 * One install (or re-install) of a Business Pack into a workspace (MN-219 /
 * #161).
 *
 * The installer (#160) is otherwise entirely stateless — every "does this
 * already exist" check is a live name lookup, which is enough for
 * idempotency but not for two things #161 needs: telling an install's own
 * re-run apart from a genuine name collision with something the user made,
 * and clean uninstall (remove what's unmodified, keep what the user has
 * since changed, with a warning). Both need to know what a pack installed,
 * which nothing recorded before this table existed.
 */
export const packInstalls = pgTable(
  'pack_installs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    installedBy: text('installed_by').notNull(),
    /** Set once uninstalled; the row stays for history rather than being deleted. */
    uninstalledAt: timestamp('uninstalled_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('pack_installs_workspace_slug_idx').on(t.workspaceId, t.slug)],
);

/**
 * One object a pack install created or reused.
 *
 * `contentHash` is a snapshot of the object's pack-relevant fields at install
 * time (see `packs.service.ts`'s `contentHashOf`), populated only for the
 * kinds uninstall independently removes (view/automation/agent/skill — see
 * `packUninstallResultSchema`'s doc). Null for every other kind: they are
 * tracked for provenance (collision detection) but uninstall never acts on
 * them, so there is nothing to diff.
 */
export const packInstallItems = pgTable(
  'pack_install_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packInstallId: uuid('pack_install_id')
      .notNull()
      .references(() => packInstalls.id, { onDelete: 'cascade' }),
    kind: packInstallItemKind('kind').notNull(),
    /** The `preview`-style label — a bare name, or `"<database>.<name>"`. */
    name: text('name').notNull(),
    entityId: uuid('entity_id').notNull(),
    action: packInstallItemAction('action').notNull(),
    contentHash: text('content_hash'),
    ...timestamps,
  },
  (t) => [
    index('pack_install_items_install_idx').on(t.packInstallId),
    index('pack_install_items_entity_idx').on(t.kind, t.entityId),
  ],
);

/**
 * #239 — the Sources framework. A source is NOT a workflow: it's a scheduled
 * sync that UPSERTS external items into a normal database by an external
 * key, so a database fed by a source is otherwise a completely ordinary
 * database — views, record_created automations, agents over MCP all just
 * work. `providerSource` is a free-text registry key (providers/index.ts, an
 * "id.subresource" shape like "youtube.comments") — never a schema change to
 * register a new one, same reasoning as `connections.provider`.
 *
 * `fieldMapping` is `{ external_key: field_id }`; `externalKeyFieldId` names
 * which mapped field_id is the upsert key (must also appear as one of
 * fieldMapping's values). `cursor` is provider-owned opaque state (page
 * tokens, watermarks) round-tripped verbatim between sync cycles.
 */
export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** SET NULL (not cascade): deleting the connection must not silently
     * delete the source's config/history — it flips to status 'error'
     * instead (SourcesService.tick / ConnectionsService.remove), same
     * "credential gone, history stays" call as automationJobs.connectionId. */
    connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    providerSource: text('provider_source').notNull(),
    config: jsonb('config').notNull().default({}),
    targetDatabaseId: uuid('target_database_id')
      .notNull()
      .references(() => databases.id, { onDelete: 'cascade' }),
    fieldMapping: jsonb('field_mapping').notNull().default({}),
    externalKeyFieldId: uuid('external_key_field_id').notNull(),
    schedule: text('schedule').notNull(), // '15m' | 'hour' | 'day'
    status: text('status').notNull().default('active'), // active | paused | error
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    cursor: jsonb('cursor').notNull().default({}),
    createdBy: text('created_by'),
    ...timestamps,
  },
  (t) => [
    index('sources_status_schedule_idx').on(t.status, t.schedule, t.lastSyncAt),
    index('sources_target_database_idx').on(t.targetDatabaseId),
  ],
);

/**
 * One sync attempt of a source (#239). MN-264's Runs & health surface
 * (runs.service.ts) unions this table with automationRuns once both exist —
 * `workspaceId` is denormalized here for exactly the reason automationRuns'
 * doc gives for doing the same off automations->databases: that union (and
 * usage_counters-style accounting) must never need a join through `sources`
 * just to scope by workspace.
 */
export const sourceRuns = pgTable(
  'source_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull(), // running | ok | error | skipped_quota
    fetched: integer('fetched').notNull().default(0),
    created: integer('created').notNull().default(0),
    updated: integer('updated').notNull().default(0),
    error: text('error'),
  },
  (t) => [
    index('source_runs_source_idx').on(t.sourceId, t.startedAt),
    index('source_runs_workspace_idx').on(t.workspaceId, t.startedAt),
  ],
);

/**
 * Append-only reward ledger — an internal account-credit balance, NOT a live
 * Stripe coupon/promotion-code mutation (deliberately out of scope here; see
 * ReferralsService doc comment for the human-review follow-up this defers
 * to). `sum(amountCents) WHERE referrerUserId = X` is the referrer's earned
 * balance; nothing ever updates or deletes a row, so the ledger itself is the
 * audit trail a human reviews before any of it is applied against a real
 * invoice.
 */
export const referralRewardGrants = pgTable(
  'referral_reward_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    signupId: uuid('signup_id')
      .notNull()
      .references(() => referralSignups.id, { onDelete: 'cascade' }),
    referrerUserId: text('referrer_user_id').notNull(),
    amountCents: integer('amount_cents').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('referral_reward_grants_referrer_idx').on(t.referrerUserId)],
);

/**
 * MN-220 — Business Packs community marketplace, v1 (curated, not open).
 *
 * Three tables, one flow: an admin `POST .../packs/submissions` an exported
 * manifest plus listing metadata → a `pack_submissions` row, `pending`. A
 * platform admin reviews it (`admin.controller.ts`); `approve` is the only
 * path that ever writes to `published_packs`/`published_pack_versions` — see
 * `MarketplaceService.review`'s doc for why there is deliberately no
 * self-serve auto-publish. `reject` only annotates the submission.
 *
 * `published_packs` is one row per slug (the listing); `published_pack_versions`
 * is the changelog — one row per approved version, newest queried by
 * `publishedAt`. Split rather than an array column on `published_packs`
 * because `PacksService.listInstalls`'s "update available" check only ever
 * needs the latest row, and a version history a person reads (the changelog)
 * is exactly the shape a table's insert-only rows are for, not a jsonb blob
 * that would need its own ordering convention invented.
 */
export const packListingVertical = pgEnum('pack_listing_vertical', [
  'sales',
  'marketing',
  'support',
  'engineering',
  'hr',
  'finance',
  'agency',
  'ops',
  'other',
]);

export const packSubmissionStatus = pgEnum('pack_submission_status', [
  'pending',
  'approved',
  'rejected',
]);

export const packSubmissions = pgTable(
  'pack_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The submitting workspace — provenance only; a submission is not workspace data. */
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    submittedBy: text('submitted_by').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    vertical: packListingVertical('vertical').notNull(),
    screenshots: jsonb('screenshots').notNull().default([]),
    /** The full manifest as submitted — `packManifestSchema`-shaped. */
    manifest: jsonb('manifest').notNull(),
    status: packSubmissionStatus('status').notNull().default('pending'),
    reviewNotes: text('review_notes'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('pack_submissions_status_idx').on(t.status, t.createdAt),
    index('pack_submissions_workspace_idx').on(t.workspaceId),
  ],
);

/** One published pack — the marketplace listing. Slug is the stable identity an upgrade matches on, same as a manifest's own `slug`. */
export const publishedPacks = pgTable(
  'published_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    summary: text('summary').notNull(),
    vertical: packListingVertical('vertical').notNull(),
    license: text('license').notNull(),
    attribution: text('attribution'),
    screenshots: jsonb('screenshots').notNull().default([]),
    /** Denormalized off `published_pack_versions` for a cheap listing read. */
    latestVersion: text('latest_version').notNull(),
    submittedByWorkspaceId: uuid('submitted_by_workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ...timestamps,
  },
  (t) => [uniqueIndex('published_packs_slug_idx').on(t.slug)],
);

/** One approved version of a published pack — the changelog, and the version `install` actually reads. */
export const publishedPackVersions = pgTable(
  'published_pack_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    publishedPackId: uuid('published_pack_id')
      .notNull()
      .references(() => publishedPacks.id, { onDelete: 'cascade' }),
    /** SET NULL: the submission is provenance, not a dependency — the version stands on its own once published. */
    submissionId: uuid('submission_id').references(() => packSubmissions.id, {
      onDelete: 'set null',
    }),
    version: text('version').notNull(),
    changelog: text('changelog'),
    manifest: jsonb('manifest').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('published_pack_versions_pack_idx').on(t.publishedPackId, t.publishedAt)],
);
