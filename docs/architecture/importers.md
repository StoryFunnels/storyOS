# Importer designs: Airtable, Notion, Monday, Fibery

Migration designs for importing **into** StoryOS from four competitors (#169–#172).
All four share the pipeline in [ADR-0013](../decisions/ADR-0013-migration-framework.md);
this doc is the per-source detail. Endpoint/format details reflect early-2026
knowledge — items marked **⚠ verify** need a live probe before the importer ships.

## Common shape

Every importer is *source API → IR → framework apply*. It contributes only: an
auth + fetch client (schema then data), a `sourceType → StoryOS field type`
mapping table, and a container→space heuristic. Idempotency is by the source's
stable id (ADR-0013's `source_id`). Attachments with expiring URLs are downloaded
and rehosted by the framework.

## Airtable

- **API:** REST `api.airtable.com/v0`. Auth: **Personal Access Token** (legacy
  keys removed 2024) or OAuth2; scopes `schema.bases:read`, `data.records:read`.
  Schema: `GET /meta/bases` → `GET /meta/bases/{baseId}/tables`. Data:
  `GET /{baseId}/{tableId}` (`pageSize`≤100, `offset` cursor). **Rate limit 5 req/s
  per base** (429 → 30s lockout) — the binding constraint.
- **Map:** base → space; table → database. text/number/currency/percent/duration,
  singleSelect→select, multipleSelects→multi-select, date, checkbox,
  single/multipleCollaborators→user, multipleRecordLinks→relation,
  lookup/rollup/count→lookup/rollup, formula→formula. No clean map: barcode,
  button, aiText → text; autoNumber/createdTime → system/read-only.
- **Relations:** `multipleRecordLinks` auto-maintains a reverse field → collapse
  the two field ids into one paired relation; `prefersSingleRecordLink` sets
  cardinality. Cross-base links rare/unsupported — flag.
- **Gotchas:** **attachment URLs expire ~2h ⚠** (download during apply);
  formula/rollup/lookup are read-only computed values (import static v1). Stable
  `app/tbl/fld/rec…` ids → excellent idempotency keys.

## Notion

- **API:** REST `api.notion.com/v1`; Bearer (internal or OAuth2 integration) +
  `Notion-Version` header. **⚠ Version split:** `2025-09-03` splits a database into
  database + one-or-more **data_source(s)**; query moved to
  `POST /data_sources/{id}/query`. Pin a version. Discover via `POST /search`
  (object=database); page bodies via `GET /blocks/{id}/children` (recursive).
  **Rate ~3 req/s** (429 + `Retry-After`). No webhooks in the core API — incremental
  by `last_edited_time`.
- **Map:** no true space (group by parent/teamspace, or one space). title/rich_text→text,
  number, select, multi_select, **status→workflow-state (ADR-0011)**, date,
  people→user, checkbox, url/email/phone→text, formula, relation, rollup,
  created/last_edited→system. No clean map: files→files, unique_id, verification,
  button→skip.
- **Relations:** `dual_property` (synced, exposes `synced_property_id`) → collapse
  to one paired relation; `single_property` → one-way. Inherently many-to-many
  (no native cardinality cap) — default to-many.
- **Gotchas:** **page content is blocks, not a field** — flatten to markdown into a
  body field (toggles/tables/columns/synced/child-pages are lossy). **Notion-hosted
  file URLs expire ~1h ⚠**; external files permanent. UUIDs stable → good keys.

## Monday.com

- **API:** **GraphQL only** (`api.monday.com/v2`); token or OAuth. **Rate limiting is
  a complexity-point budget**, not req/s — read `complexity` in responses and back
  off. Query `boards → groups, columns, items_page(limit:500, cursor)` (cursor
  pagination; legacy `items(page:)` deprecated). Column schema from
  `columns{id title type settings_str}`; values from `column_values` (typed
  fragments e.g. `... on StatusValue`).
- **Map:** Monday workspace → space; board → database; **groups** have no equivalent →
  materialize as a select/workflow "Group" field. text/long_text→text, numbers→number,
  status→**workflow-state**, dropdown/tags→multi-select, date/timeline→date (timeline
  is a range → two dates, lossy), people→user, checkbox, link/email/phone/location→text,
  connect_boards→relation, mirror→lookup/rollup. Subitems = a hidden sub-board →
  import as a separate database + relation.
- **Relations:** `connect_boards` + its separate reverse column → one paired relation
  (`settings_str` names the target board); `dependency` → relation.
- **Gotchas:** **formula column values are historically NOT returned by the API ⚠** —
  import the definition or recompute; **mirror values also unreliable via API ⚠**;
  assets `public_url` → download+rehost. Stable numeric item/board ids + string
  column ids.

## Fibery

- **API:** token (Bearer). Command API `POST /api/commands` (`fibery.schema/query`
  for schema; `fibery.entity/query` DSL for data, `q/limit`+`q/offset` paging) **or**
  a per-workspace GraphQL API. Rich-text bodies + files are separate
  **documents/files referenced by secret id** (extra fetch per field). **Rate
  limits undocumented ⚠** — conservative backoff.
- **Map (closest cousin, highest fidelity):** Fibery space → StoryOS space; type
  (`Space/Type`) → database. text/int/decimal/date/date-time/bool, single-enum→select,
  multi→multi-select, **workflow state → workflow-state (near-direct, ADR-0011)**,
  Document(rich text)→body/text, files→files, user→user, relations→relation,
  formula→formula, lookups→lookup; rank/created/public-id→system.
- **Relations:** first-class with **explicit cardinality** and a named reverse field
  → maps almost 1:1 to StoryOS paired relations; read cardinality from schema,
  collapse both sides. Cross-database + self-relations supported.
- **Gotchas:** rich-text indirected through document secrets (convert Fibery
  markdown); files indirected. `fibery/id` + public-id → stable keys. **Build this
  importer first** as the framework's reference implementation.
