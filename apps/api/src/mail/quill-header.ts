/**
 * The ONE Quill header card (ticket #1266): every email StoryOS sends opens with
 * Quill's avatar and the line "Quill from StoryOS". Shared by the branded shell
 * (`renderBrandedEmail` in templates.ts, which every transactional email and the
 * automation send-email action go through) and by the My work digest's own
 * layout. A new email layout must call `quillHeaderHtml` and include
 * `QUILL_HEADER_CSS` in its <style>; `quill-header.test.ts` fails a source file
 * that renders a whole HTML document without both.
 *
 * Images are PNG rasters (most mail clients block inline SVG), served as static
 * files from apps/web's public/ dir at WEB_URL, the same way the wordmark PNGs
 * are. Light and dark are two <img>s swapped with the same `display` toggle the
 * dark-mode CSS already uses; image-blocking clients show the alt text "Quill".
 */

export const QUILL_ALT = 'Quill';
export const QUILL_LINE = 'Quill from StoryOS';

/** Dara's dark email values (same as the digest's DARK tokens). */
const INK = '#0f1729';
const INK_DARK = '#f3efe7';

export const QUILL_HEADER_CSS =
  `@media (prefers-color-scheme: dark){` +
  `.d-quill-light{display:none!important}` +
  `.d-quill-dark{display:inline-block!important}` +
  `.d-quill-line{color:${INK_DARK}!important}}`;

const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** Path (under WEB_URL) of one avatar raster. */
export function quillAvatarPath(theme: 'light' | 'dark', px: 96 | 192): string {
  return `/brand/email/quill-avatar-${theme}-${px}.png`;
}

export function quillHeaderHtml(webUrl: string): string {
  const base = webUrl.replace(/\/$/, '');
  const img = (theme: 'light' | 'dark', hidden: boolean) =>
    `<img src="${base}${quillAvatarPath(theme, 96)}" srcset="${base}${quillAvatarPath(theme, 96)} 1x, ${base}${quillAvatarPath(theme, 192)} 2x" width="48" height="48" alt="${QUILL_ALT}" class="d-quill-${theme}" style="display:${hidden ? 'none' : 'inline-block'};width:48px;height:48px;border:0;border-radius:10px;vertical-align:middle;font-family:${FONT};font-size:14px;color:${theme === 'dark' ? INK_DARK : INK}">`;
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="d-quill-card" style="margin:0 auto"><tr>` +
    `<td style="padding:0 12px 0 0;vertical-align:middle">${img('light', false)}${img('dark', true)}</td>` +
    `<td class="d-quill-line" style="vertical-align:middle;font-family:${FONT};font-size:15px;line-height:20px;font-weight:700;color:${INK}">${QUILL_LINE}</td>` +
    `</tr></table>`
  );
}
