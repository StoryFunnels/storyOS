/**
 * Ticket #1386 — the sentence under the History dialog, kept in its own file so a test can pin what it may promise.
 *
 * What is TRUE (apps/api/src/activity/history-window.ts and version-history-retention.service.ts): a hosted workspace's plan sets a
 * window (Free 14 days, Pro 270, Business 730, Enterprise 1825), and from 2026-12-27 UTC changes older than it are neither listed nor
 * restorable and a daily job deletes them. BEFORE that date nothing is hidden and nothing is deleted. A deployment without plans
 * (self-hosted) has no window and keeps everything.
 *
 * So the sentence says WHEN, as a fact about the future that stays true after the date passes ("from 27 December 2026"), instead of
 * a present-tense claim ("older changes are pruned automatically") that was false until the job shipped. It does not name a day
 * count: the exact number sits behind the admin-only billing endpoint and this dialog is not admin-only. When the date has long
 * passed, the date can go; the rest stays true.
 */
export const HISTORY_RETENTION_NOTE =
  "On a hosted plan, how far back history goes depends on your workspace's plan. From 27 December 2026, changes older than that are removed automatically and can no longer be restored.";
