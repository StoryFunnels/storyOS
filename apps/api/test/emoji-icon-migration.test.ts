import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectTestDb, truncateAll } from './helpers/db';
import { databases, spaces, workspaces } from '../src/db/schema';
import { migrateEmojiIcons } from '../src/icons/migrate-emoji-icons';
import { scanEmojiIcons } from '../src/icons/scan-emoji-icons';

const { db, pool } = connectTestDb();

let wsId: string;
let spaceId: string;
/** A known emoji (🤝 → handshake/teal). */
let dbKnown: string;
/** An emoji with no migration-table entry; name "Clients" should still land
 * on the handshake icon via the name-inferred fallback. */
let dbUnmappedNamed: string;
/** An emoji with no migration entry AND a name with no keyword match at all —
 * should fall back to the generic default (`set:database`). */
let dbUnmappedGeneric: string;
/** Already migrated — must be left untouched. */
let dbAlreadyMigrated: string;
/** No icon at all — nothing to do. */
let dbNoIcon: string;
/** A known emoji, but the row already has an explicit color — migration must
 * set the icon and preserve the existing color, not overwrite it. */
let dbKeepsExistingColor: string;
/** A space with a known emoji, to prove spaces are migrated too. */
let spaceKnown: string;

beforeAll(async () => {
  await truncateAll(pool);

  const [ws] = await db.insert(workspaces).values({ name: 'Icon WS', slug: 'icon-ws' }).returning();
  wsId = ws!.id;

  const [space] = await db
    .insert(spaces)
    .values({ workspaceId: wsId, name: 'General', slug: 'general' })
    .returning();
  spaceId = space!.id;

  const [known] = await db
    .insert(databases)
    .values({ workspaceId: wsId, spaceId, name: 'Clients', icon: '🤝', apiSlug: 'clients' })
    .returning();
  dbKnown = known!.id;

  const [unmappedNamed] = await db
    .insert(databases)
    .values({ workspaceId: wsId, spaceId, name: 'Clients', icon: '👍', apiSlug: 'clients-2' })
    .returning();
  dbUnmappedNamed = unmappedNamed!.id;

  const [unmappedGeneric] = await db
    .insert(databases)
    .values({ workspaceId: wsId, spaceId, name: 'Zzzqqx Nonsense', icon: '👍', apiSlug: 'zzzqqx' })
    .returning();
  dbUnmappedGeneric = unmappedGeneric!.id;

  const [migrated] = await db
    .insert(databases)
    .values({ workspaceId: wsId, spaceId, name: 'Already Set', icon: 'set:rocket', color: 'blue', apiSlug: 'already-set' })
    .returning();
  dbAlreadyMigrated = migrated!.id;

  const [noIcon] = await db
    .insert(databases)
    .values({ workspaceId: wsId, spaceId, name: 'No Icon', apiSlug: 'no-icon' })
    .returning();
  dbNoIcon = noIcon!.id;

  const [keepsColor] = await db
    .insert(databases)
    .values({ workspaceId: wsId, spaceId, name: 'Releases', icon: '🚀', color: 'red', apiSlug: 'releases' })
    .returning();
  dbKeepsExistingColor = keepsColor!.id;

  const [space2] = await db
    .insert(spaces)
    .values({ workspaceId: wsId, name: 'Pinned Space', slug: 'pinned-space', icon: '📌' })
    .returning();
  spaceKnown = space2!.id;
});

afterAll(async () => {
  await pool.end();
});

describe('emoji icon migration backfill (#251)', () => {
  it('the pre-migration scan finds every emoji-shaped icon (databases + spaces)', async () => {
    const hits = await scanEmojiIcons(db);
    const ids = hits.map((h) => h.id);
    expect(ids).toEqual(
      expect.arrayContaining([dbKnown, dbUnmappedNamed, dbUnmappedGeneric, dbKeepsExistingColor, spaceKnown]),
    );
    expect(ids).not.toContain(dbAlreadyMigrated);
    expect(ids).not.toContain(dbNoIcon);
  });

  it('migrates a known emoji to its mapped icon + color', async () => {
    await migrateEmojiIcons(db);
    const [row] = await db.select().from(databases).where(eq(databases.id, dbKnown));
    expect(row!.icon).toBe('set:handshake');
    expect(row!.color).toBe('teal');
  });

  it('falls back to the name-inferred default when the emoji itself is unmapped', async () => {
    const [namedRow] = await db.select().from(databases).where(eq(databases.id, dbUnmappedNamed));
    // "Clients" → handshake (people), same as the direct 🤝 mapping — the name
    // carries the signal once the emoji itself doesn't.
    expect(namedRow!.icon).toBe('set:handshake');

    const [genericRow] = await db.select().from(databases).where(eq(databases.id, dbUnmappedGeneric));
    expect(genericRow!.icon).toBe('set:database');
  });

  it('leaves an already-migrated set: ref untouched', async () => {
    const [row] = await db.select().from(databases).where(eq(databases.id, dbAlreadyMigrated));
    expect(row!.icon).toBe('set:rocket');
    expect(row!.color).toBe('blue');
  });

  it('leaves a null icon alone', async () => {
    const [row] = await db.select().from(databases).where(eq(databases.id, dbNoIcon));
    expect(row!.icon).toBeNull();
  });

  it('sets the icon but preserves an existing color', async () => {
    const [row] = await db.select().from(databases).where(eq(databases.id, dbKeepsExistingColor));
    expect(row!.icon).toBe('set:rocket');
    expect(row!.color).toBe('red'); // NOT overwritten with the mapping's default 'blue'
  });

  it('migrates spaces too', async () => {
    const [row] = await db.select().from(spaces).where(eq(spaces.id, spaceKnown));
    expect(row!.icon).toBe('set:pin');
  });

  it('the post-migration scan finds zero emoji-shaped icons', async () => {
    const hits = await scanEmojiIcons(db);
    expect(hits).toEqual([]);
  });

  it('is idempotent: running it again migrates nothing and changes nothing', async () => {
    const before = await db.select().from(databases).where(eq(databases.id, dbKnown));
    const beforeSpace = await db.select().from(spaces).where(eq(spaces.id, spaceKnown));

    const result = await migrateEmojiIcons(db);
    expect(result.databases.migrated).toBe(0);
    expect(result.spaces.migrated).toBe(0);

    const after = await db.select().from(databases).where(eq(databases.id, dbKnown));
    const afterSpace = await db.select().from(spaces).where(eq(spaces.id, spaceKnown));
    expect(after).toEqual(before);
    expect(afterSpace).toEqual(beforeSpace);

    const hits = await scanEmojiIcons(db);
    expect(hits).toEqual([]);
  });
});
