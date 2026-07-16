-- MN-125: clean BEFORE constraining — these ALTERs fail on real data otherwise.

-- 1. Dangling database grants. database_id had no FK, so a grant outlived its
--    database and could later match a recycled id. The FK below rejects these.
DELETE FROM "access_grants" ga
WHERE ga.database_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "databases" d WHERE d.id = ga.database_id);
--> statement-breakpoint

-- 2. Rows violating the scope XOR (both set, or neither). The service always
--    claimed exactly one; nothing enforced it.
DELETE FROM "access_grants"
WHERE (space_id IS NULL) = (database_id IS NULL);
--> statement-breakpoint

-- 3. Duplicate grants for the same (user, scope), from the read-then-write upsert.
--    Keep the HIGHEST role: reads already took a max, so this preserves everyone's
--    effective access exactly — the cleanup changes storage, not permissions.
DELETE FROM "access_grants" a
USING "access_grants" b
WHERE a.id <> b.id
  AND a.user_id = b.user_id
  AND (
    (a.space_id IS NOT NULL AND a.space_id = b.space_id)
    OR (a.database_id IS NOT NULL AND a.database_id = b.database_id)
  )
  AND (
    array_position(ARRAY['viewer','commenter','contributor','editor','creator']::text[], b.role::text)
      > array_position(ARRAY['viewer','commenter','contributor','editor','creator']::text[], a.role::text)
    OR (
      b.role = a.role
      AND (b.created_at > a.created_at OR (b.created_at = a.created_at AND b.id > a.id))
    )
  );
--> statement-breakpoint

ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_database_id_databases_id_fk" FOREIGN KEY ("database_id") REFERENCES "public"."databases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_user_space_uq" ON "access_grants" USING btree ("user_id","space_id") WHERE "access_grants"."space_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "access_grants_user_database_uq" ON "access_grants" USING btree ("user_id","database_id") WHERE "access_grants"."database_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "access_grants" ADD CONSTRAINT "access_grants_scope_xor" CHECK (("access_grants"."space_id" IS NULL) <> ("access_grants"."database_id" IS NULL));