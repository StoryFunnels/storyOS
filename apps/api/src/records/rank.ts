/**
 * Fractional-index ranks (ADR-0005). fractional-indexing is ESM-only; under
 * NodeNext CJS, TypeScript preserves dynamic import(), so we load it lazily.
 */
let mod: Promise<typeof import('fractional-indexing')> | null = null;

function lib() {
  mod ??= import('fractional-indexing');
  return mod;
}

export async function keyBetween(a: string | null, b: string | null): Promise<string> {
  return (await lib()).generateKeyBetween(a, b);
}

export async function keysAfter(a: string | null, count: number): Promise<string[]> {
  return (await lib()).generateNKeysBetween(a, null, count);
}

/**
 * #480/#487 — `count` keys strictly between `a` and `b` (both bounds, unlike
 * `keysAfter`'s open-ended `count` after `a`). Used by the duplicate-position
 * repair: re-keying the LOSING rows of a tie into the gap between the shared
 * key and whatever comes after it, rather than appending them at the end of
 * the whole list.
 */
export async function keysBetween(a: string | null, b: string | null, count: number): Promise<string[]> {
  return (await lib()).generateNKeysBetween(a, b, count);
}
