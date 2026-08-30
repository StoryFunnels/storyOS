/** Template registry types (MN-033). Definitions are pure data; the installer resolves. */

export type TemplateCategory = 'agency' | 'creators' | 'dev' | 'marketing' | 'people';
export type TemplateScope = 'pack' | 'database';

export interface TemplateFieldDef {
  key: string;
  display_name: string;
  type:
    | 'text'
    | 'rich_text'
    | 'number'
    | 'checkbox'
    | 'date'
    | 'select'
    /* #218 — the canonical status type. Its absence from this union is WHY no
       template ever seeded one: a lifecycle "Status" could only be typed as a
       plain select, which is the debt #218 exists to pay off. */
    | 'workflow'
    | 'multi_select'
    | 'url'
    | 'email'
    | 'user';
  config?: Record<string, unknown>;
  options?: Array<{ label: string; color?: string }>;
}

export interface TemplateDatabaseDef {
  key: string;
  name: string;
  icon?: string;
  fields: TemplateFieldDef[];
}

export interface TemplateRelationDef {
  key: string;
  /** side A = the "many" side for one_to_many. Self-relations: database_b === database_a. */
  database_a: string;
  /** Either another database in this template… */
  database_b?: string;
  /** …or an EXISTING workspace database by name (cross-pack). Skipped when absent. */
  external_target_name?: string;
  cardinality: 'one_to_many' | 'many_to_many';
  field_a_name: string;
  field_b_name: string;
}

export interface TemplateFilterDef {
  /** field key within the same database */
  field: string;
  op: string;
  /** select/user values by option LABEL; '@me' resolves to the me-token; other literals pass through */
  values?: unknown[];
  value?: unknown;
}

export interface TemplateViewDef {
  database: string;
  name: string;
  type: 'table' | 'board' | 'calendar' | 'gallery' | 'list' | 'feed' | 'timeline';
  group_by_field?: string; // field key
  date_field?: string; // field key (calendar)
  /** Timeline only — the bar's start (required) + optional end date field. */
  start_date_field?: string;
  end_date_field?: string;
  /** Gallery/list/feed/board card body fields (also calendar chips). */
  card_fields?: string[];
  filters?: TemplateFilterDef[];
  sorts?: Array<{ field: string; direction: 'asc' | 'desc' }>; // field keys
}

export interface TemplateRecordDef {
  key?: string;
  database: string;
  /** field keys; select values by LABEL; '@me' for user fields */
  values: Record<string, unknown>;
  links?: Array<{ relation: string; to: string }>;
}

/**
 * #455 — a rule a pack ships pre-wired.
 *
 * `enabled` is the literal `false`, not `boolean`. A pack author who writes
 * `enabled: true` fails to COMPILE rather than failing at review, which is the
 * difference between a safety property and a convention. The installer passes
 * this through, so there is no path — definition, review or install — by which
 * a pack can switch on a rule in someone else's workspace.
 */
export interface TemplateAutomationDef {
  /** The pack-local database key the rule lives on. */
  database: string;
  name: string;
  /** Same shape the API takes; field refs are pack-local keys, resolved at install. */
  trigger: Record<string, unknown>;
  condition?: Record<string, unknown>;
  actions: Array<Record<string, unknown>>;
  /** Always false. Typed as the literal so an enabled pack rule cannot be written. */
  enabled: false;
  /**
   * Provider descriptor ids this rule's actions need before it can be switched
   * on — e.g. ['slack']. Surfaced at install and enforced on enable (#455).
   */
  requires_connections?: string[];
}

/**
 * #455 — a source a pack expects, offered as a SUGGESTION.
 *
 * Installing a pack never creates a source. A source needs a connection the
 * installing workspace may not have, and creating one that cannot authenticate
 * produces a broken integration the user did not ask for and has to diagnose.
 */
export interface TemplateSuggestedSourceDef {
  /** Provider descriptor id from the sources provider registry. */
  provider: string;
  /** What this source would bring in, in the pack's own words. */
  description: string;
  /** The pack-local database key it would populate. */
  database?: string;
}

export interface TemplateDef {
  /** Markdown guide shipped with the pack (MN-053) — shown in the gallery. */
  guide?: string;
  slug: string;
  name: string;
  description: string;
  category: TemplateCategory;
  scope: TemplateScope;
  /** pack: the space it installs; database: ignored (installs into a chosen space) */
  space?: string;
  databases: TemplateDatabaseDef[];
  relations: TemplateRelationDef[];
  views: TemplateViewDef[];
  records: TemplateRecordDef[];
  /** #455 — rules the pack ships, always installed disabled. */
  automations?: TemplateAutomationDef[];
  /** #455 — sources the pack expects. Never created; surfaced for the user to act on. */
  suggested_sources?: TemplateSuggestedSourceDef[];
}

export interface IntentDef {
  id: string;
  label: string;
  description: string;
  template: string; // slug
  /** 'new client' pre-fills the space name from user input */
  asks_name?: string;
  /** finish on the guest-invite dialog with an editor grant preselected */
  ends_with_invite?: boolean;
}
