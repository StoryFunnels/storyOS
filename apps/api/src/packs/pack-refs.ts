import { UnprocessableEntityException } from '@nestjs/common';
import { PACK_REF_PATTERN } from '@storyos/schemas';

/**
 * Ref rewriting (MN-218 / #160) — the crux of the pack format.
 *
 * A view config stores `group_by_field_id`, `card_field_ids`,
 * `form.fields[].field_id`, and `column_widths` *keyed* by field id. An
 * automation stores `trigger.field_id` and, inside its actions,
 * `database_id` / `relation_field_id` / `link_via_relation_field_id`. A rollup
 * stores `relation_field_id`. None of those ids exist in the workspace a pack is
 * installed into, so every one of them has to become a symbolic ref on export
 * and a fresh id on install. Miss one and the object installs *looking* fine
 * while pointing at another workspace's field — the failure this module exists
 * to prevent, and the one `packs.test.ts` asserts against explicitly.
 *
 * ── Why this walks the blob instead of mapping known keys ────────────────────
 *
 * The obvious implementation is a rewrite per known id-bearing key. It is also
 * the one that rots: `viewConfigSchema` has grown `color_by_field_id`,
 * `start_date_field_id`, `end_date_field_id` and `column_widths` over time, and
 * each of those would have been a silent breakage — a pack exported the day
 * before, installing with a dangling id and no error. So the walk is generic and
 * *value-driven*: anything that is a known id becomes a ref, wherever it sits
 * and however deeply nested, including object keys. Adding a new id-bearing
 * config key requires no change here.
 *
 * The price of a value-driven walk is that it cannot tell an id in a slot that
 * means "field" from a coincidentally id-shaped string. In practice ids are
 * uuids and nothing else in these blobs is, and the alternative — a hand-kept
 * key list — trades a theoretical false positive for a recurring real bug.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const looksLikeUuid = (value: string) => UUID.test(value);

/**
 * What to do with a uuid that has no ref — i.e. a reference to something outside
 * the exported slice.
 *
 *   throw — for configs. A view grouped by a field the pack does not contain is
 *           a pack that installs broken; refusing at export is the only point at
 *           which somebody can still fix it.
 *   drop  — for sample record values, where an id may legitimately be data
 *           (a link to a record that is not coming along) rather than schema.
 */
type UnknownIdPolicy = 'throw' | 'drop';

const DROP = Symbol('drop');

/**
 * ids → refs. Used on export.
 *
 * `where` names the object being rewritten so a dangling reference is reported
 * as "the view \"Pipeline\" references …" rather than as a bare uuid the
 * operator has no way to place.
 */
export function refify(
  value: unknown,
  idToRef: ReadonlyMap<string, string>,
  where: string,
  policy: UnknownIdPolicy = 'throw',
): unknown {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const ref = idToRef.get(node);
      if (ref) return ref;
      if (!looksLikeUuid(node)) return node;
      if (policy === 'drop') return DROP;
      throw new UnprocessableEntityException(
        `${where} references something outside this pack (id ${node}). A pack must be ` +
          `self-contained — widen the export to include it, or remove the reference — ` +
          `otherwise it would install pointing at nothing.`,
      );
    }
    if (Array.isArray(node)) {
      const out = node.map(walk).filter((v) => v !== DROP);
      return out;
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(node)) {
        // Keys matter: `column_widths` is keyed BY field id. A rewrite that only
        // touched values would leave a config that validates, installs, and
        // sizes nothing.
        const newKey = walk(key);
        const newValue = walk(raw);
        if (newKey === DROP || newValue === DROP) continue;
        out[newKey as string] = newValue;
      }
      return out;
    }
    return node;
  };

  const result = walk(value);
  return result === DROP ? undefined : result;
}

/**
 * refs → ids. Used on install, after the schema exists.
 *
 * An unresolvable ref is a 422 and never a best-effort skip: the whole point of
 * the format is that a ref is a promise the manifest makes about its own
 * contents, and a broken promise means the manifest is malformed. Installing the
 * object anyway would produce exactly the silent breakage refs prevent.
 */
export function deref(value: unknown, refToId: ReadonlyMap<string, string>, where: string): unknown {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (!PACK_REF_PATTERN.test(node)) return node;
      const id = refToId.get(node);
      if (!id) {
        throw new UnprocessableEntityException(
          `${where} references "${node}", which this pack does not declare. ` +
            `Every ref must resolve to something the manifest creates.`,
        );
      }
      return id;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(node)) {
        out[walk(key) as string] = walk(raw);
      }
      return out;
    }
    return node;
  };
  return walk(value);
}

/**
 * Every raw uuid left in a value — the export-side self-check.
 *
 * Export asserts this is empty before returning. That is a belt-and-braces
 * check over `refify`'s own policy, and it is cheap: the ACs turn on "no raw ids
 * leak into the manifest", so the exporter proves it rather than trusting that
 * every path through the walk was reached.
 */
export function findRawUuids(value: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      if (looksLikeUuid(node)) found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, raw] of Object.entries(node)) {
        walk(key);
        walk(raw);
      }
    }
  };
  walk(value);
  return found;
}
