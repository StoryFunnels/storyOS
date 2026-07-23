/**
 * MN-261 — the normalized "Engagement" shape every social source emits.
 * One target database (an "Engagement" database) can hold rows from all
 * three providers because they all agree on these external keys — the
 * field_mapping a workspace draws just picks which of these lands in which
 * column, same as any other source (sources.service.ts's upsertBatch).
 *
 * `external_id` is the intended upsert key (source.external_key_field_id
 * should map to it) — it must be unique PER PROVIDER, which is why
 * `provider` is also emitted: two providers could otherwise collide on a
 * numeric id that means nothing across platforms.
 */
export interface EngagementItem {
  /** Registry id of the emitting source provider, e.g. "meta.page_comments". */
  provider: string;
  kind: 'comment' | 'mention' | 'reply';
  /** UPSERT key. Provider-native id, e.g. a Graph API comment id or a tweet id. */
  external_id: string;
  author_handle: string | null;
  author_name: string | null;
  text: string;
  permalink: string | null;
  /** The comment/tweet this one is a reply to, if any (thread parent). */
  parent_external_id: string | null;
  /** The top-level post/tweet/share this engagement is attached to. */
  post_external_id: string | null;
  /** ISO 8601. */
  posted_at: string | null;
}

const REQUIRED_KEYS: ReadonlyArray<keyof EngagementItem> = [
  'provider',
  'kind',
  'external_id',
  'author_handle',
  'author_name',
  'text',
  'permalink',
  'parent_external_id',
  'post_external_id',
  'posted_at',
];

const VALID_KINDS = new Set(['comment', 'mention', 'reply']);

/**
 * Conformance check shared by every provider's test suite (MN-261's "one
 * parametrized test all providers must pass") — throws with the first thing
 * wrong rather than returning a boolean, so a failing assertion names the
 * actual defect instead of just "not an EngagementItem".
 */
export function assertEngagementShape(
  item: Record<string, unknown>,
): asserts item is EngagementItem & Record<string, unknown> {
  for (const key of REQUIRED_KEYS) {
    if (!(key in item)) throw new Error(`EngagementItem is missing "${key}"`);
  }
  if (typeof item['provider'] !== 'string' || !item['provider']) {
    throw new Error('EngagementItem.provider must be a non-empty string');
  }
  if (typeof item['kind'] !== 'string' || !VALID_KINDS.has(item['kind'])) {
    throw new Error(`EngagementItem.kind must be one of comment|mention|reply, got "${String(item['kind'])}"`);
  }
  if (typeof item['external_id'] !== 'string' || !item['external_id']) {
    throw new Error('EngagementItem.external_id must be a non-empty string');
  }
  if (typeof item['text'] !== 'string') {
    throw new Error('EngagementItem.text must be a string (use "" for no body text, never null/undefined)');
  }
  for (const nullable of ['author_handle', 'author_name', 'permalink', 'parent_external_id', 'post_external_id', 'posted_at'] as const) {
    const v = item[nullable];
    if (v !== null && typeof v !== 'string') {
      throw new Error(`EngagementItem.${nullable} must be a string or null, got ${typeof v}`);
    }
  }
}
