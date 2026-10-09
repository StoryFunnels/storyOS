import * as twitterText from 'twitter-text';
import type { Field } from '@/components/table-view/use-table-data';

/**
 * Ticket #826 — the rules behind the post_social editor and the approval preview, as plain
 * functions so they are testable and cannot drift between the two surfaces.
 */
/**
 * `twitter-text` is CommonJS. Node's ESM interop (the unit tests) exposes `parseTweet` as a named
 * export; webpack's browser bundle exposes it only on the default/namespace object, where a plain
 * `import { parseTweet }` is `undefined` and the preview crashed on first render. Resolve it from
 * whichever shape the bundler gave us.
 */
type TweetParser = (text: string) => { weightedLength: number };
const parseTweet: TweetParser = (
  (twitterText as unknown as { parseTweet?: TweetParser; default?: { parseTweet?: TweetParser } }).parseTweet ??
  (twitterText as unknown as { default?: { parseTweet?: TweetParser } }).default?.parseTweet
) as TweetParser;

export type SocialTarget = 'linkedin_org' | 'linkedin_member' | 'x';

export const TARGET_LABEL: Record<SocialTarget, string> = {
  linkedin_org: 'LinkedIn company page',
  linkedin_member: 'LinkedIn profile',
  x: 'X',
};

/** The provider a target posts through. Mirrors the server's own save-time check (actions.service.ts). */
export function providerForTarget(target: SocialTarget): 'linkedin' | 'x' {
  return target === 'x' ? 'x' : 'linkedin';
}

/** The targets a connection of this provider can post as. */
export function targetsFor(provider: string): SocialTarget[] {
  if (provider === 'x') return ['x'];
  if (provider === 'linkedin') return ['linkedin_org', 'linkedin_member'];
  return [];
}

export const TARGET_LIMIT: Record<SocialTarget, number> = { linkedin_org: 3000, linkedin_member: 3000, x: 280 };

export interface LengthReading {
  length: number;
  limit: number;
  over: boolean;
}

/**
 * How long the text is for the chosen target. X is measured the way X measures it (weighted:
 * a link counts 23, many scripts and emoji count 2), the same function the API uses. This reads
 * the TEMPLATE as typed; `{Field}` tokens are filled in when the post is rendered, so the server's
 * render-time check stays the authority.
 */
export function lengthFor(target: SocialTarget, text: string): LengthReading {
  const limit = TARGET_LIMIT[target];
  const length = target === 'x' ? parseTweet(text).weightedLength : text.length;
  return { length, limit, over: length > limit };
}

/** Attachment fields, for the image the post carries (its first attachment is what is published). */
export function mediaFields(fields: Field[]): Field[] {
  return fields.filter((f) => f.type === 'attachment');
}

/** Where the published post's URL is written back, and the dedup key: a url or text field. */
export function resultFields(fields: Field[]): Field[] {
  return fields.filter((f) => (f.type === 'url' || f.type === 'text') && !f.isSystem);
}

export interface PostAttachment {
  id: string;
  filename: string;
  mime: string;
  has_thumbnail: boolean;
}

/**
 * The image that WILL go out: the media field's FIRST attachment on the record, read at the moment
 * of looking, because the executor attaches at publish time rather than freezing the file into the
 * approval. A preview of what was attached at compose time would be a different, wrong answer.
 */
export function imageThatWillBePublished(
  value: unknown,
): { attachment: PostAttachment; extra: number } | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const [first, ...rest] = value as PostAttachment[];
  return first ? { attachment: first, extra: rest.length } : null;
}

export interface PostSnapshot {
  type: 'post_social';
  connection_id: string;
  target: SocialTarget;
  text: string;
  link?: string;
  media_field_id?: string;
}

/**
 * The post an approval holds, or null if it holds anything else. An approval's `action_snapshot` is
 * `{ ctx, action }` — the action is one level down, which a first draft of the preview got wrong and
 * which only a live approval revealed (it would have rendered for nobody).
 */
export function postSnapshotOf(approval: { action_snapshot?: { action?: { type?: string } } | null } | undefined): PostSnapshot | null {
  const action = approval?.action_snapshot?.action;
  return action?.type === 'post_social' ? (action as unknown as PostSnapshot) : null;
}
