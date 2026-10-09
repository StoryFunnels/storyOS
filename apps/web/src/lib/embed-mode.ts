/**
 * #721 — which light/dark treatment an EMBEDDED form gets, chosen by the host in
 * the builder and carried on the embed URL as `theme=light|dark`.
 *
 * THE HOST DECIDES, NEVER THE VISITOR (AC1; phase 0 of #711). An embedded form is
 * a component of somebody else's page, so the visitor's own device setting tells
 * us nothing about that page's theme: a light careers page viewed on a dark
 * laptop would otherwise render a dark form on a light page, which is exactly the
 * bug phase 0 fixed. So there are two modes and BOTH are explicit pins. A third,
 * "follow the visitor's device", was considered and dropped: it serves only hosts
 * whose own page adapts to the device, and it hands everyone else a one-click way
 * to reproduce the bug. If a host with an adaptive page ever asks, that is a new
 * ticket with real demand behind it.
 *
 *   light — pinned light. ALSO what an absent or unrecognised value means, so
 *           every existing embed is untouched.
 *   dark  — pinned dark, for a host whose own site is dark.
 *
 * WHY A URL PARAMETER, when #711's AC1 rejected them: that objection was about
 * COLOURS, which change often during brand tuning, so re-pasting an iframe each
 * time is a tax. A light/dark switch is set once and essentially never revisited,
 * and the BUILDER writes the snippet, so the customer copies something we
 * produced rather than hand-editing a URL. It is also the only transport with no
 * flash: a stored mode would arrive with the fetched form definition, after first
 * paint. (Serving it at document level, option (b) on the ticket, stays available
 * as a follow-on if /f/[token] ever needs server rendering for its own reasons.)
 *
 * The param is a RENDERING HINT on a public form URL. It is cosmetic (no security
 * question), is validated against these two values with a fallback to light, and
 * must never be copied into a submission or an analytics property.
 */
export type EmbedMode = 'light' | 'dark';

export const EMBED_MODES: readonly EmbedMode[] = ['light', 'dark'];

/** Anything that is not exactly `dark` is `light`: a typo must never produce an
 * unstyled or half-painted page, and absent must mean today's behaviour. */
export function parseEmbedMode(raw: unknown): EmbedMode {
  return raw === 'dark' ? 'dark' : 'light';
}

/** The mode requested by an embed URL's query string. */
export function embedModeFromSearch(search: string): EmbedMode {
  return parseEmbedMode(new URLSearchParams(search).get('theme'));
}

/**
 * The embed code the builder hands out. `light` emits NOTHING extra: absent
 * config renders light, so an unchanged embed stays byte-identical to today's.
 */
export function embedSnippet(origin: string, token: string, mode: EmbedMode = 'light'): string {
  const theme = mode === 'light' ? '' : `&theme=${mode}`;
  return `<iframe src="${origin}/f/${token}?embed=1${theme}" width="100%" height="600" style="border:0"></iframe>`;
}

export const EMBED_MODE_LABELS: Record<EmbedMode, string> = {
  light: 'Light',
  dark: 'Dark',
};

export const EMBED_MODE_HINTS: Record<EmbedMode, string> = {
  light: 'Always light, whatever device the visitor uses. The default.',
  dark: 'Always dark. Use this if your own site is dark.',
};
