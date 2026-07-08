/** Template registry types (MN-033). Definitions are pure data; the installer resolves. */

export type TemplateCategory = 'agency' | 'creators' | 'dev';
export type TemplateScope = 'pack' | 'database';

export interface TemplateFieldDef {
  key: string;
  display_name: string;
  type:
    | 'text'
    | 'number'
    | 'checkbox'
    | 'date'
    | 'select'
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
  type: 'table' | 'board';
  group_by_field?: string; // field key
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

export interface TemplateDef {
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
