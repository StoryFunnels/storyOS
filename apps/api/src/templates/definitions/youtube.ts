import type { TemplateDef } from '../types';

/** YouTube-specific database templates surfaced only from the integration setup. */
export const youtubeVideosDatabase: TemplateDef = {
  slug: 'youtube-videos',
  name: 'YouTube videos',
  description: 'A source-ready catalog for videos from a connected YouTube channel.',
  category: 'marketing',
  scope: 'database',
  guide: `## YouTube videos

Create this database from **Settings → Integrations → YouTube**, then add the YouTube videos source.
Map each source value to the matching maintained field.`,
  databases: [
    {
      key: 'youtube_videos',
      name: 'YouTube Videos',
      icon: 'film',
      fields: [
        { key: 'video_id', display_name: 'Video ID', type: 'text' },
        { key: 'youtube_title', display_name: 'YouTube Title', type: 'text' },
        { key: 'published_at', display_name: 'Published At', type: 'text' },
        { key: 'duration', display_name: 'Duration', type: 'text' },
        { key: 'privacy', display_name: 'Privacy', type: 'text' },
        { key: 'url', display_name: 'URL', type: 'url' },
      ],
    },
  ],
  relations: [],
  views: [
    {
      database: 'youtube_videos',
      name: 'Video library',
      type: 'gallery',
      card_fields: ['youtube_title', 'published_at', 'privacy', 'url'],
    },
    {
      database: 'youtube_videos',
      name: 'All videos',
      type: 'table',
      sorts: [{ field: 'published_at', direction: 'desc' }],
    },
  ],
  records: [],
};

export const youtubeCommentsDatabase: TemplateDef = {
  slug: 'youtube-comments',
  name: 'YouTube comments',
  description: 'A source-ready inbox for channel comments and replies.',
  category: 'marketing',
  scope: 'database',
  guide: `## YouTube comments

Create this database from **Settings → Integrations → YouTube**, then add the YouTube comments source.
The maintained fields match the source mapping one-for-one.`,
  databases: [
    {
      key: 'youtube_comments',
      name: 'YouTube Comments',
      icon: 'message-square',
      fields: [
        { key: 'comment_id', display_name: 'Comment ID', type: 'text' },
        { key: 'video_id', display_name: 'Video ID', type: 'text' },
        { key: 'author_name', display_name: 'Author', type: 'text' },
        { key: 'text', display_name: 'Comment', type: 'rich_text' },
        { key: 'like_count', display_name: 'Likes', type: 'number' },
        { key: 'published_at', display_name: 'Published At', type: 'text' },
        { key: 'is_reply', display_name: 'Is Reply', type: 'checkbox' },
        { key: 'permalink', display_name: 'Permalink', type: 'url' },
      ],
    },
  ],
  relations: [],
  views: [
    {
      database: 'youtube_comments',
      name: 'Comment inbox',
      type: 'feed',
      card_fields: ['author_name', 'text', 'like_count', 'permalink'],
    },
    {
      database: 'youtube_comments',
      name: 'All comments',
      type: 'table',
      sorts: [{ field: 'published_at', direction: 'desc' }],
    },
  ],
  records: [],
};

export const youtubeMetricsDatabase: TemplateDef = {
  slug: 'youtube-metrics',
  name: 'YouTube metrics',
  description: 'Daily video metric snapshots ready for the YouTube metrics source.',
  category: 'marketing',
  scope: 'database',
  guide: `## YouTube metrics

Create this database from **Settings → Integrations → YouTube**, then add the daily metrics source.
Provide video ids directly or pair it with a YouTube videos source.`,
  databases: [
    {
      key: 'youtube_metrics',
      name: 'YouTube Metrics',
      icon: 'chart-line',
      fields: [
        { key: 'snapshot_id', display_name: 'Snapshot ID', type: 'text' },
        { key: 'video_id', display_name: 'Video ID', type: 'text' },
        { key: 'date', display_name: 'Date', type: 'text' },
        { key: 'views', display_name: 'Views', type: 'number' },
        { key: 'likes', display_name: 'Likes', type: 'number' },
        { key: 'comments', display_name: 'Comments', type: 'number' },
      ],
    },
  ],
  relations: [],
  views: [
    {
      database: 'youtube_metrics',
      name: 'Latest snapshots',
      type: 'table',
      sorts: [{ field: 'date', direction: 'desc' }],
    },
  ],
  records: [],
};
