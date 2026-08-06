import { collectMentions } from '../mentions/mentions.service';
import type { BlocknoteCommentBody, CommentBody } from './comments.service';

/**
 * #235 — the single place a comment body becomes human-readable text, so the
 * mention email, the in-app inbox snippet, and any future channel (Slack) all
 * show the SAME wording for the same comment. Before this, each channel called
 * its own `.slice()` on a preview that collapsed every mention to a bare "@…",
 * which is exactly what the Fibery thread complained about ("the actual comment
 * comes along" — but only if you can read who was mentioned).
 *
 * This module is the leaf: it owns the body-shape guard and the flatten/mention
 * walk, and the service depends on it (never the reverse), so there is no import
 * cycle. Name resolution is caller-supplied (`ctx`) because the durable mention
 * node stores only an id, never the rendered name (see collectMentions) — the
 * renderer must not invent a DB round-trip of its own.
 */
export interface CommentRenderContext {
  /** userId → display name, for @user mentions. Missing → "@someone". */
  userNames?: ReadonlyMap<string, string>;
  /** recordId → title, for #record mentions. Missing → "#record". */
  recordTitles?: ReadonlyMap<string, string>;
}

/** True for the new `{ format: 'blocknote', doc }` shape; false for the legacy array. */
export function isBlocknoteCommentBody(body: CommentBody): body is BlocknoteCommentBody {
  return !Array.isArray(body) && (body as BlocknoteCommentBody)?.format === 'blocknote';
}

function renderUser(id: string, ctx: CommentRenderContext): string {
  return `@${ctx.userNames?.get(id) ?? 'someone'}`;
}

function renderRecord(id: string, ctx: CommentRenderContext): string {
  const title = ctx.recordTitles?.get(id);
  return title ? `#${title}` : '#record';
}

/**
 * Flatten a comment body (either the legacy `CommentSegment[]` or the BlockNote
 * `{ format, doc }` shape — #180) to a single readable line. Mentions render as
 * "@Name" / "#Title" when `ctx` resolves them, otherwise a stable placeholder.
 */
export function renderCommentText(body: CommentBody, ctx: CommentRenderContext = {}): string {
  if (!isBlocknoteCommentBody(body)) {
    return body
      .map((s) => {
        if (s.type === 'text') return s.text;
        if (s.type === 'mention') return renderUser(s.user_id, ctx);
        return renderRecord(s.record_id, ctx);
      })
      .join('');
  }
  const parts: string[] = [];
  const walkInline = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const o = n as { type?: unknown; text?: unknown; props?: { kind?: unknown; id?: unknown } };
      if (o.type === 'mention' && o.props && typeof o.props.id === 'string') {
        parts.push(o.props.kind === 'record' ? renderRecord(o.props.id, ctx) : renderUser(o.props.id, ctx));
      } else if (typeof o.text === 'string') {
        parts.push(o.text);
      }
    }
  };
  const walkBlocks = (blocks: unknown): void => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      const o = (b ?? {}) as { content?: unknown; children?: unknown };
      walkInline(o.content);
      if (Array.isArray(o.children)) walkBlocks(o.children);
      parts.push(' ');
    }
  };
  walkBlocks(body.doc);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * The @user + #record ids a comment references, from EITHER shape (#180), so a
 * caller can resolve names ONCE and hand the maps back via a render context.
 */
export function commentMentionIds(body: CommentBody): { userIds: string[]; recordIds: string[] } {
  if (isBlocknoteCommentBody(body)) return collectMentions(body.doc);
  const userIds = [...new Set(body.filter((s) => s.type === 'mention').map((s) => s.user_id))];
  const recordIds = [...new Set(body.filter((s) => s.type === 'record').map((s) => s.record_id))];
  return { userIds, recordIds };
}

/**
 * Truncate a rendered comment to `max` chars for a preview, breaking on a word
 * boundary and appending an ellipsis so a channel never shows a half-word. The
 * ellipsis is the reader's cue that a "view more" (the deep link) opens the full
 * thread.
 */
export function truncateForPreview(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * Deep link that opens a record with the exact comment targeted (`?comment=`),
 * shared by every channel so email/Slack/inbox all point at the same anchor.
 * Web scroll-to-comment consumes this param (follow-up); until then it opens the
 * record's comment thread, which is already better than no link.
 */
export function commentDeepLink(webUrl: string, recordId: string, commentId: string): string {
  return `${webUrl}/r/${recordId}?comment=${commentId}`;
}
