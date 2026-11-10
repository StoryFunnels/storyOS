import { escapeHtml } from '../mail/templates';
import { QUILL_HEADER_CSS, quillHeaderHtml } from '../mail/quill-header';

/**
 * Ticket #1251 — the My work digest, rendered to Dara's approved template (v4, artifact "My Work Digest"): one column, tables and inline
 * styles only, so the phone width needs no media query (the chip stays right, titles wrap). Section order is Waiting on you, Assigned to
 * you, You assigned to others; an empty section is dropped; nothing is rendered (null) when every section is empty. No AI writes any of it.
 *
 * Every caller-supplied string (titles, names) is escaped here; the markup is ours.
 */
export const DIGEST_ROWS_PER_SECTION = 15;

export type ChipTone = 'neutral' | 'progress' | 'attention';

export interface DigestRow {
  title: string;
  url: string;
  /** "Dariia · Website Tasks · Borderlands Group · #31" — already joined, plain text. */
  meta: string;
  chip?: { label: string; tone: ChipTone };
}

export interface DigestSection {
  key: 'waiting' | 'assigned' | 'assigned_by_me';
  /** The exact count (a SQL count, never the length of `rows`). */
  total: number;
  /** At most DIGEST_ROWS_PER_SECTION are drawn; the rest become "and N more". */
  rows: DigestRow[];
}

export interface DigestInput {
  workspaceName: string;
  /** e.g. "Tue 10 Nov", in the person's zone. */
  dateLabel: string;
  sections: DigestSection[];
  recipientEmail: string;
  /** "every weekday (Mon–Fri) at 08:00" / "every Monday at 08:00" */
  cadenceText: string;
  /** App origin (WEB_URL); the Quill header's avatar PNGs are served from it. */
  webUrl: string;
  myWorkUrl: string;
  customizeUrl: string;
  stopUrl: string;
}

const COPY: Record<DigestSection['key'], { heading: string; countLabel: (n: number) => string; blurb: string }> = {
  waiting: {
    heading: 'Waiting on you',
    countLabel: (n) => String(n),
    blurb: 'Approvals you can decide and mentions you have not answered.',
  },
  assigned: {
    heading: 'Assigned to you',
    countLabel: (n) => `${n} open`,
    blurb: 'Overdue first, then due this week, then In Progress, then not started; latest change first in each.',
  },
  assigned_by_me: {
    heading: 'You assigned to others',
    countLabel: (n) => `${n} still open`,
    blurb: 'Records you assigned to someone else that are still open.',
  },
};

const CHIP: Record<ChipTone, { bg: string; border: string; fg: string }> = {
  neutral: { bg: '#efece6', border: '#efece6', fg: '#3d3a30' },
  progress: { bg: '#e6eaf5', border: '#e6eaf5', fg: '#2f3b63' },
  attention: { bg: '#fbf0d4', border: '#fbf0d4', fg: '#7a5a00' },
};

/**
 * Dark mode. Dara's values: page #0a0d12, text #f3efe7, muted #9a9488, links #a9b9e6 (card and rule are the pair the page sat on).
 * Email clients differ, so the LIGHT colours stay inline (they are the default everywhere, including clients that ignore <style>), and
 * the dark values are overrides keyed on classes. `!important` is required because an inline style otherwise wins. Every element that
 * carries an inline colour also carries one of these classes; digest-render.test.ts walks the output and fails on one that does not.
 * `[data-ogsc]` / `[data-ogsb]` are Outlook.com's dark-mode hooks (text / background), listed from the same table so they cannot drift.
 */
export const DARK = { page: '#0a0d12', card: '#171c26', rule: '#262d39', text: '#f3efe7', muted: '#9a9488', link: '#a9b9e6' } as const;
const DARK_RULES: Array<{ cls: string; fg?: string; bg?: string; border?: string }> = [
  { cls: 'd-page', bg: DARK.page },
  { cls: 'd-card', bg: DARK.card, border: DARK.rule },
  { cls: 'd-rule', border: DARK.rule },
  { cls: 'd-ink', fg: DARK.text },
  { cls: 'd-mute', fg: DARK.muted },
  { cls: 'd-link', fg: DARK.link },
  { cls: 'd-btn', fg: DARK.page, bg: DARK.link },
  { cls: 'd-mono', fg: DARK.page, bg: DARK.link },
  { cls: 'd-chip-neutral', fg: DARK.text, bg: DARK.rule, border: DARK.rule },
  { cls: 'd-chip-progress', fg: DARK.link, bg: '#1f2a4a', border: '#1f2a4a' },
  { cls: 'd-chip-attention', fg: '#f0cf7a', bg: '#3a2f10', border: '#3a2f10' },
];
export const DARK_CSS =
  `:root{color-scheme:light dark;supported-color-schemes:light dark}` +
  `@media (prefers-color-scheme: dark){${DARK_RULES.map((r) => `.${r.cls}{${[r.bg && `background:${r.bg}!important`, r.fg && `color:${r.fg}!important`, r.border && `border-color:${r.border}!important`].filter(Boolean).join(';')}}`).join('')}}` +
  DARK_RULES.filter((r) => r.fg).map((r) => `[data-ogsc] .${r.cls}{color:${r.fg}!important}`).join('') +
  DARK_RULES.filter((r) => r.bg).map((r) => `[data-ogsb] .${r.cls}{background-color:${r.bg}!important}`).join('');

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summaryParts(sections: DigestSection[]): { waiting: number; open: number; byMe: number } {
  const total = (k: DigestSection['key']) => sections.find((s) => s.key === k)?.total ?? 0;
  return { waiting: total('waiting'), open: total('assigned'), byMe: total('assigned_by_me') };
}

export function digestSubject(workspaceName: string, sections: DigestSection[]): string {
  const { waiting, open, byMe } = summaryParts(sections);
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${waiting} waiting`);
  if (open > 0) parts.push(`${open} open`);
  if (parts.length === 0 && byMe > 0) parts.push(`${byMe} you assigned still open`);
  return `Your work in ${workspaceName}: ${parts.join(', ')}`;
}

function intro(sections: DigestSection[]): string {
  const { waiting, open, byMe } = summaryParts(sections);
  const out: string[] = [];
  if (waiting > 0) out.push(`${plural(waiting, 'thing is', 'things are')} waiting on you.`);
  if (open > 0 && byMe > 0) out.push(`${open} open ${open === 1 ? 'record is' : 'records are'} assigned to you, and ${byMe} you assigned to others ${byMe === 1 ? 'is' : 'are'} still open.`);
  else if (open > 0) out.push(`${open} open ${open === 1 ? 'record is' : 'records are'} assigned to you.`);
  else if (byMe > 0) out.push(`${byMe} you assigned to others ${byMe === 1 ? 'is' : 'are'} still open.`);
  return out.join(' ');
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => w[0]!).join('') : (words[0] ?? '').slice(0, 2);
  return letters.toUpperCase();
}

function rowHtml(row: DigestRow): string {
  const chip = row.chip
    ? (() => {
        const c = CHIP[row.chip.tone];
        return `<span class="d-chip-${row.chip.tone}" style="display:inline-block;padding:2px 8px;border:1px solid ${c.border};border-radius:4px;background:${c.bg};color:${c.fg};font-size:12px;line-height:16px;font-weight:600;white-space:nowrap">${escapeHtml(row.chip.label)}</span>`;
      })()
    : '';
  return (
    `<tr><td class="d-rule" style="padding:12px 0;border-top:1px solid #e8e5df;vertical-align:top"><a class="d-ink" href="${escapeHtml(row.url)}" style="color:#0f1729;text-decoration:none;font-size:15px;line-height:21px;font-weight:600">${escapeHtml(row.title)}</a><br>` +
    `<span class="d-mute" style="color:#6b6658;font-size:12px;line-height:18px">${escapeHtml(row.meta)}</span></td>` +
    `<td width="8" style="width:8px"></td>` +
    `<td align="right" class="d-rule" style="padding:13px 0 0;border-top:1px solid #e8e5df;vertical-align:top;white-space:nowrap">${chip}</td></tr>`
  );
}

function sectionHtml(section: DigestSection, myWorkUrl: string): string {
  const copy = COPY[section.key];
  const shown = section.rows.slice(0, DIGEST_ROWS_PER_SECTION);
  const more = section.total - shown.length;
  const moreRow =
    more > 0
      ? `<tr><td colspan="3" class="d-rule d-mute" style="padding:12px 0 0;border-top:1px solid #e8e5df;font-size:13px;line-height:20px;color:#6b6658">and ${more} more &middot; <a class="d-link" href="${escapeHtml(myWorkUrl)}" style="color:#2f3b63;font-weight:600;text-decoration:underline">see them all in My Work</a></td></tr>`
      : '';
  return (
    `<tr><td style="padding:40px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    `<tr><td colspan="3" class="d-rule d-mute" style="padding:14px 0 6px;border-top:2px solid #d9d4c8;font-size:11px;line-height:16px;letter-spacing:.08em;text-transform:uppercase;font-weight:700;color:#6b6658">${copy.heading} <span class="d-mute" style="color:#8f8a7e">&middot;</span> <span class="d-ink" style="color:#0f1729">${copy.countLabel(section.total)}</span></td></tr>` +
    `<tr><td colspan="3" class="d-mute" style="padding:0 0 10px;font-size:13px;line-height:19px;color:#6b6658">${copy.blurb}</td></tr>` +
    shown.map(rowHtml).join('') +
    moreRow +
    `</table></td></tr>`
  );
}

/** Null when there is nothing to say: every section empty. The caller sends no email. */
export function renderDigest(input: DigestInput): { subject: string; html: string; text: string } | null {
  // The approved order is the renderer's rule, not the caller's: whoever builds the sections cannot reorder them.
  const ORDER: DigestSection['key'][] = ['waiting', 'assigned', 'assigned_by_me'];
  const sections = input.sections.filter((s) => s.total > 0).sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  if (sections.length === 0) return null;
  const subject = digestSubject(input.workspaceName, sections);
  const lead = intro(sections);
  const { waiting, open, byMe } = summaryParts(sections);
  const preheader = [waiting > 0 ? `${waiting} waiting on you` : '', open > 0 ? `${open} assigned to you` : '', byMe > 0 ? `${byMe} you assigned to others` : '']
    .filter(Boolean)
    .join(', ');

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${escapeHtml(subject)}</title>` +
    `<style>${DARK_CSS}${QUILL_HEADER_CSS}</style></head>\n` +
    `<body class="d-page" style="margin:0;padding:0;background:#f4efe5;font-family:Figtree,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%">\n` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}.</div>\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4efe5" class="d-page"><tr><td align="center" style="padding:24px 12px">\n` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="d-card" style="max-width:600px;background:#ffffff;border:1px solid #e8e5df;border-radius:8px">\n` +
    `<tr><td align="center" style="padding:20px 24px 0">${quillHeaderHtml(input.webUrl)}</td></tr>\n` +
    `<tr><td style="padding:22px 24px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>` +
    `<td class="d-ink" style="font-size:13px;line-height:18px;font-weight:700;color:#0f1729"><span class="d-mono" style="display:inline-block;width:18px;height:18px;line-height:18px;text-align:center;border-radius:4px;background:#2f3b63;color:#fff;font-size:10px;font-weight:700;vertical-align:-4px;margin-right:6px">${escapeHtml(initials(input.workspaceName))}</span>${escapeHtml(input.workspaceName)}</td>` +
    `<td align="right" class="d-mute" style="font-size:12px;line-height:18px;color:#6b6658;white-space:nowrap">${escapeHtml(input.dateLabel)}</td></tr></table></td></tr>\n` +
    `<tr><td style="padding:18px 24px 0"><h1 class="d-ink" style="margin:0;font-size:22px;line-height:28px;font-weight:700;color:#0f1729">Your work today</h1>` +
    `<p class="d-mute" style="margin:6px 0 0;font-size:14px;line-height:21px;color:#6b6658">${escapeHtml(lead)}</p>` +
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px"><tr><td class="d-btn" style="border-radius:6px;background:#2f3b63"><a class="d-btn" href="${escapeHtml(input.myWorkUrl)}" style="display:inline-block;padding:9px 16px;font-size:14px;line-height:18px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">Open My Work</a></td></tr></table></td></tr>\n` +
    sections.map((s) => sectionHtml(s, input.myWorkUrl)).join('') +
    `\n<tr><td style="padding:28px 24px 22px">` +
    `<p class="d-mute d-rule" style="margin:0;padding-top:16px;border-top:1px solid #e8e5df;font-size:12px;line-height:18px;color:#6b6658">You get this ${escapeHtml(input.cadenceText)}, your time, because you turned it on in Settings &rsaquo; Notifications. It lists only records you can open, the same list as My Work.</p>` +
    `<p style="margin:8px 0 0;font-size:12px;line-height:18px"><a class="d-link" href="${escapeHtml(input.customizeUrl)}" style="color:#2f3b63;text-decoration:underline">Customize these emails</a> <span class="d-mute" style="color:#8f8a7e">&middot;</span> <a class="d-link" href="${escapeHtml(input.stopUrl)}" style="color:#2f3b63;text-decoration:underline">Stop these emails</a></p>` +
    `<p class="d-mute" style="margin:8px 0 0;font-size:12px;line-height:18px;color:#8f8a7e">StoryOS &middot; sent to ${escapeHtml(input.recipientEmail)}</p>` +
    `</td></tr>\n</table></td></tr></table></body></html>`;

  const textLines: string[] = [`Your work today — ${input.workspaceName}, ${input.dateLabel}`, '', lead, ''];
  for (const s of sections) {
    const copy = COPY[s.key];
    textLines.push(`${copy.heading.toUpperCase()} (${copy.countLabel(s.total)})`);
    const shown = s.rows.slice(0, DIGEST_ROWS_PER_SECTION);
    for (const r of shown) textLines.push(`- ${r.title}${r.chip ? ` [${r.chip.label}]` : ''}`, `  ${r.meta}`, `  ${r.url}`);
    if (s.total > shown.length) textLines.push(`and ${s.total - shown.length} more: ${input.myWorkUrl}`);
    textLines.push('');
  }
  textLines.push(`Open My Work: ${input.myWorkUrl}`, '', `You get this ${input.cadenceText}.`, `Customize these emails: ${input.customizeUrl}`, `Stop these emails: ${input.stopUrl}`);
  return { subject, html, text: textLines.join('\n') };
}
