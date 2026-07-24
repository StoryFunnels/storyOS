# ADR-0015: Data durability and recovery

Status: Accepted as a delivery plan (targets are not customer guarantees until
the corresponding controls and restore drills are live)

Date: 2026-07-24

## Context

StoryOS can hold the operating data for an entire business. Durability therefore
needs more than a database backup checkbox: we must recover the hosted service,
let a workspace owner take away all of their data, preserve recoverable history
for individual records, and give self-hosters a tested procedure they can run
themselves.

Record snapshots and restore endpoints shipped in MN-231 / PR #115. The other
layers remain delivery work.

## Decision

StoryOS uses four independent recovery layers.

### 1. Managed-cloud infrastructure recovery

- PostgreSQL uses continuous WAL archiving / provider PITR plus encrypted daily
  snapshots.
- Initial engineering targets are a database RPO of 15 minutes and an RTO of
  four hours.
- Attachment storage has object versioning enabled with lifecycle retention of
  at least 30 days. Deletion markers remain recoverable during that window.
- Database backups and attachment versions live in a failure domain separate
  from the primary service. Encryption keys and access are restricted to the
  recovery role.
- Restore is tested into an isolated environment at least quarterly. A drill is
  successful only after application-level integrity checks pass; a provider
  dashboard saying "restored" is insufficient.
- Backup success, WAL freshness, object-versioning status, and drill age are
  monitored and alertable.

The RPO/RTO values above are internal targets until repeated drills demonstrate
them. Public trust copy must describe measured guarantees, not this plan.

### 2. Workspace-owned export

- An owner can request an on-demand full-workspace export.
- The export is a versioned archive containing a pack-format manifest, records,
  relations, documents, comments/activity where portable, attachment metadata,
  and the attachment files themselves.
- Export jobs are asynchronous, auditable, encrypted in transit and at rest,
  expire after a short download window, and never expose another workspace.
- A machine-readable report identifies anything not portable or omitted.
- The archive format is documented sufficiently for a customer to inspect it
  without StoryOS.

Scheduled exports can reuse the same job after the on-demand path is proven.

### 3. Record-level history

- `record_versions` keeps pre-write snapshots and supports full restore.
- Restoring creates another snapshot first, so restore is reversible.
- The API remains the source of truth; a user-facing diff/history/restore
  surface is delivered separately.
- Retention and pruning policy must be decided before unbounded history becomes
  a material storage risk.

Document history follows the same product model but is a separate implementation
because document blocks and collaboration semantics differ from record values.

### 4. Self-host recovery

- Operators own backup storage, scheduling, encryption, monitoring, and drills.
- StoryOS documents a consistent `pg_dump` + attachment-volume backup path and
  a restore procedure.
- The documented procedure is tested against the released Docker Compose stack.
- Larger installations should use PostgreSQL-native continuous archiving rather
  than relying only on logical dumps.

## Restore order

1. Stop writes or isolate the recovery environment.
2. Restore PostgreSQL to the chosen point.
3. Restore the matching attachment-object/volume state.
4. Start the API with migrations disabled until the restored schema is
   inspected; then apply only migrations newer than the restored release.
5. Run integrity checks: database connectivity, workspace counts, record and
   relation reads, attachment download, authentication, and migration journal.
6. Record actual RPO/RTO and obtain an operator sign-off before redirecting
   production traffic.

## Security and privacy

- Backup access is production access and follows least privilege.
- Restore environments are private, time-limited, and destroyed after the
  drill/incident.
- Retention applies to backups as well as primary data; account erasure
  documentation must explain delayed expiry from immutable backups.
- Export URLs are single-purpose, short-lived, and never logged with secrets.

## Delivery phases

1. Managed PostgreSQL PITR, object versioning, monitoring, and the first restore
   drill.
2. Owner-requested full-workspace export with attachment bundle and report.
3. Record-history UI and explicit retention policy.
4. Tested self-host backup/restore script and release-check procedure.
5. Public trust-page claims after measured RPO/RTO evidence exists.

Each phase is tracked as its own StoryOS issue. MN-231 closes when those tickets
exist and this plan is merged; it does not claim that the operational controls
are already live.

