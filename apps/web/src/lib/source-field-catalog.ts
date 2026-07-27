import type { CatalogItem } from '@/lib/source-field-match';

/**
 * #239 — the mapping catalog every known-ahead-of-time source provider emits,
 * since none of them implement `discover()` yet. Shared between the "Sync from…"
 * dialog (sources-dialog.tsx) and the integration setup pages that auto-attach a
 * source (#109 — the YouTube integration page pre-maps a source on database
 * creation), so both build the same field mapping from one source of truth.
 * MN-261/MN-262 add their own entries here when they register new providers.
 */
export const PROVIDER_FIELD_CATALOG: Record<string, CatalogItem[]> = {
  'youtube.videos': [
    { key: 'video_id', label: 'Video ID', suggestedType: 'text', isKey: true },
    { key: 'title', label: 'Title', suggestedType: 'text' },
    { key: 'published_at', label: 'Published at', suggestedType: 'text' },
    { key: 'duration', label: 'Duration', suggestedType: 'text' },
    { key: 'privacy', label: 'Privacy', suggestedType: 'text' },
    { key: 'url', label: 'URL', suggestedType: 'url' },
  ],
  'youtube.comments': [
    { key: 'comment_id', label: 'Comment ID', suggestedType: 'text', isKey: true },
    { key: 'video_id', label: 'Video ID', suggestedType: 'text' },
    { key: 'author_name', label: 'Author', suggestedType: 'text' },
    { key: 'text', label: 'Text', suggestedType: 'text' },
    { key: 'like_count', label: 'Likes', suggestedType: 'number' },
    { key: 'published_at', label: 'Published at', suggestedType: 'text' },
    { key: 'is_reply', label: 'Is reply', suggestedType: 'checkbox' },
    { key: 'permalink', label: 'Permalink', suggestedType: 'url' },
  ],
  'youtube.metrics': [
    { key: 'snapshot_id', label: 'Snapshot ID', suggestedType: 'text', isKey: true },
    { key: 'video_id', label: 'Video ID', suggestedType: 'text' },
    { key: 'date', label: 'Date', suggestedType: 'text' },
    { key: 'views', label: 'Views', suggestedType: 'number' },
    { key: 'likes', label: 'Likes', suggestedType: 'number' },
    { key: 'comments', label: 'Comments', suggestedType: 'number' },
  ],
};
