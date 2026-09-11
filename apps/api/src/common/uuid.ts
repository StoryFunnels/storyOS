/**
 * #613 — a plain uuid-SHAPE check, deliberately factored out rather than
 * added as an inline regex at yet another call site. This exact pattern
 * already exists at least twice in this codebase (field-ref.ts's private
 * `UUID_SHAPED`, packs/pack-refs.ts's exported `looksLikeUuid`) — a third,
 * inline copy here would be the same drift this codebase's own comments
 * warn about (#375/#380/#383/#399/#408/#422). This is not a merge of those
 * two (different modules, different call shapes) — just the stop for this
 * ticket's new call site, so it isn't a fourth.
 *
 * Never throws — a non-uuid-shaped id is a fact the caller decides what to
 * do about (today, always 404), the same convention `field-ref.ts`'s
 * `resolveFieldId` already established for the identical problem.
 */
const UUID_SHAPED = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function looksLikeUuid(value: string): boolean {
  return UUID_SHAPED.test(value);
}
