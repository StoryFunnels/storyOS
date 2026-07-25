-- StoryOS post-restore integrity checks (#322).
--
-- Pure SQL, no psql meta-commands, so this ONE file is the single source of
-- truth for "did the restore land intact" — it is run identically by:
--   * scripts/backup-restore/restore.sh  (via `psql -f`), and
--   * apps/api/test/backup-restore.test.ts  (via node-postgres `query()`),
-- which is the drift guard: if the schema moves under these checks, the test
-- goes red in CI before the documented procedure can rot.
--
-- Every check RAISEs EXCEPTION on failure, so a non-zero psql exit / a thrown
-- query is an unambiguous "restore is NOT trustworthy". Structural only: it
-- proves auth data loaded, rows are present, and every relation edge still
-- resolves to real endpoints. Row-count parity against the source and the
-- on-disk attachment files are asserted by the calling script, which knows the
-- expected numbers (the MANIFEST) and can see the volume.

DO $$
DECLARE
  n_users        bigint;
  n_sessions     bigint;
  n_workspaces   bigint;
  n_records      bigint;
  orphan_links   bigint;
  orphan_records bigint;
  orphan_attach  bigint;
BEGIN
  -- 1. Auth survived: at least one user, and the session table is readable.
  --    A restore that silently dropped auth would leave nobody able to log in.
  SELECT count(*) INTO n_users FROM "user";
  IF n_users = 0 THEN
    RAISE EXCEPTION 'integrity: auth check failed — 0 users after restore (nobody could log in)';
  END IF;
  SELECT count(*) INTO n_sessions FROM "session";  -- readable = table + columns restored

  -- 2. The workspace spine is present.
  SELECT count(*) INTO n_workspaces FROM workspaces;
  IF n_workspaces = 0 THEN
    RAISE EXCEPTION 'integrity: 0 workspaces after restore';
  END IF;
  SELECT count(*) INTO n_records FROM records;

  -- 3. Relations resolve: every relation edge points at a live relation row and
  --    two live records. Broken foreign keys survive a partial / out-of-order
  --    restore even though the tables exist, so this is the real "relations
  --    resolve" assertion, not a tautology.
  SELECT count(*) INTO orphan_links
  FROM record_links rl
  LEFT JOIN relations r ON r.id = rl.relation_id
  LEFT JOIN records f   ON f.id = rl.from_record_id
  LEFT JOIN records t   ON t.id = rl.to_record_id
  WHERE r.id IS NULL OR f.id IS NULL OR t.id IS NULL;
  IF orphan_links > 0 THEN
    RAISE EXCEPTION 'integrity: % relation link(s) reference a missing relation/record', orphan_links;
  END IF;

  -- 4. Every record belongs to a real database.
  SELECT count(*) INTO orphan_records
  FROM records rec
  LEFT JOIN databases d ON d.id = rec.database_id
  WHERE d.id IS NULL;
  IF orphan_records > 0 THEN
    RAISE EXCEPTION 'integrity: % record(s) reference a missing database', orphan_records;
  END IF;

  -- 5. Every attachment row points at a live record. (The on-disk file for each
  --    storage_key is checked by the calling script against the restored
  --    volume / object store — see restore.sh.)
  SELECT count(*) INTO orphan_attach
  FROM attachments a
  LEFT JOIN records rec ON rec.id = a.record_id
  WHERE rec.id IS NULL;
  IF orphan_attach > 0 THEN
    RAISE EXCEPTION 'integrity: % attachment(s) reference a missing record', orphan_attach;
  END IF;

  RAISE NOTICE 'integrity OK: % users, % sessions, % workspaces, % records, relations+attachments resolve',
    n_users, n_sessions, n_workspaces, n_records;
END $$;
