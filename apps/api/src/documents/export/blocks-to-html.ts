/**
 * #262 phase 2 — BlockNote blocks → one SELF-CONTAINED HTML document, the input
 * the PDF sidecar renders.
 *
 * This is a new OUTPUT format, not a second Markdown writer: `@storyos/schemas/
 * markdown` stays the only definition of how a document becomes Markdown. HTML
 * exists because the renderer is a browser, and a browser lays text out itself —
 * which is also what fixes "text is cut through at the margins".
 *
 * Self-contained on purpose. The sidecar has no network egress (#794), so nothing
 * here may reference an external resource: CSS is inline, images arrive as
 * `data:` URIs already resolved by the caller, and a link is just an anchor the
 * renderer never follows.
 *
 * Nothing is dropped silently. The block set mirrors what the serializer now
 * keeps (#822): nesting, images, dividers, toggles, tables. A block this file
 * does not know still renders its text; an image that cannot be inlined renders
 * a visible placeholder and is counted, so the caller can say so.
 */

interface Styles {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
}

interface Block {
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: unknown;
}

export interface HtmlExportOptions {
  /** An image block's `url` → a `data:` URI, or null when it cannot be inlined. */
  resolveImage: (url: string) => Promise<string | null>;
}

export interface HtmlExportResult {
  html: string;
  /** Image blocks that could not be inlined and rendered as a placeholder. */
  skippedImages: number;
}

const LIST_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem', 'toggleListItem']);

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only web and mail links survive. A `javascript:` or `data:` href is dropped to plain text. */
function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function textWithBreaks(text: string): string {
  return escapeHtml(text).replace(/\r?\n/g, '<br>');
}

function inlineToHtml(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) => {
      const node = raw as { type?: string; text?: unknown; styles?: Styles; href?: unknown; content?: unknown; props?: Record<string, unknown> };
      if (node?.type === 'mention') {
        const kind = node.props?.kind === 'record' ? '#' : '@';
        const label = typeof node.props?.label === 'string' ? node.props.label : '';
        return `<span class="mention">${escapeHtml(`${kind}${label}`)}</span>`;
      }
      if (node?.type === 'link') {
        const inner = inlineToHtml(node.content);
        const href = safeHref(node.href);
        return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
      }
      let html = textWithBreaks(typeof node?.text === 'string' ? node.text : '');
      const s = node?.styles ?? {};
      if (s.code) html = `<code>${html}</code>`;
      if (s.bold) html = `<strong>${html}</strong>`;
      if (s.italic) html = `<em>${html}</em>`;
      if (s.underline) html = `<u>${html}</u>`;
      if (s.strike) html = `<s>${html}</s>`;
      return html;
    })
    .join('');
}

/** Plain text of an inline array, for code blocks and captions. */
function inlineToText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((raw) => {
      const node = raw as { type?: string; text?: unknown; content?: unknown; props?: Record<string, unknown> };
      if (node?.type === 'link') return inlineToText(node.content);
      if (node?.type === 'mention') return String(node.props?.label ?? '');
      return typeof node?.text === 'string' ? node.text : '';
    })
    .join('');
}

/** BlockNote has shipped table cells as bare inline arrays and as `{type:'tableCell', content}`. */
function cellToHtml(cell: unknown): string {
  if (Array.isArray(cell)) return inlineToHtml(cell);
  const inner = (cell as { content?: unknown } | null)?.content;
  return inlineToHtml(inner);
}

function tableToHtml(content: unknown): string {
  const t = content as { rows?: Array<{ cells?: unknown[] }>; headerRows?: number } | null;
  const rows = Array.isArray(t?.rows) ? t.rows : [];
  if (rows.length === 0) return '';
  const headerRows = Math.max(0, Math.min(Number(t?.headerRows ?? 0) || 0, rows.length));
  const renderRow = (row: { cells?: unknown[] }, tag: 'th' | 'td') =>
    `<tr>${(Array.isArray(row?.cells) ? row.cells : []).map((c) => `<${tag}>${cellToHtml(c)}</${tag}>`).join('')}</tr>`;
  const head = rows.slice(0, headerRows).map((r) => renderRow(r, 'th')).join('');
  const body = rows.slice(headerRows).map((r) => renderRow(r, 'td')).join('');
  return `<table>${head ? `<thead>${head}</thead>` : ''}<tbody>${body}</tbody></table>`;
}

interface Counter {
  skippedImages: number;
}

async function imageToHtml(block: Block, opts: HtmlExportOptions, counter: Counter): Promise<string> {
  const url = typeof block.props?.url === 'string' ? block.props.url : '';
  const caption = typeof block.props?.caption === 'string' ? block.props.caption : '';
  const name = typeof block.props?.name === 'string' ? block.props.name : '';
  const label = caption || name;
  // An empty url is an image block with nothing in it — nothing to lose, nothing to flag.
  if (!url) return '';
  const dataUri = await opts.resolveImage(url);
  if (!dataUri) {
    counter.skippedImages += 1;
    return `<p class="missing">[Image not included${label ? `: ${escapeHtml(label)}` : ''}]</p>`;
  }
  const cap = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : '';
  return `<figure><img src="${escapeHtml(dataUri)}" alt="${escapeHtml(label)}">${cap}</figure>`;
}

async function renderBlocks(blocks: unknown, opts: HtmlExportOptions, counter: Counter): Promise<string> {
  if (!Array.isArray(blocks)) return '';
  const out: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i] as Block;
    if (LIST_TYPES.has(String(block?.type))) {
      // A run of consecutive list items of one family becomes ONE list element.
      const ordered = block.type === 'numberedListItem';
      const check = block.type === 'checkListItem';
      const items: string[] = [];
      const start = ordered && typeof block.props?.start === 'number' ? block.props.start : undefined;
      while (i < blocks.length && LIST_TYPES.has(String((blocks[i] as Block)?.type)) && ((blocks[i] as Block).type === 'numberedListItem') === ordered && ((blocks[i] as Block).type === 'checkListItem') === check) {
        const item = blocks[i] as Block;
        const box = check ? `<span class="box">${item.props?.checked ? '&#9745;' : '&#9744;'}</span> ` : '';
        const nested = await renderBlocks(item.children, opts, counter);
        items.push(`<li>${box}${inlineToHtml(item.content)}${nested}</li>`);
        i += 1;
      }
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = start !== undefined && start !== 1 ? ` start="${start}"` : '';
      out.push(`<${tag}${check ? ' class="check"' : ''}${startAttr}>${items.join('')}</${tag}>`);
      continue;
    }

    let html: string;
    switch (block?.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(block.props?.level ?? 1) || 1));
        html = `<h${level}>${inlineToHtml(block.content)}</h${level}>`;
        break;
      }
      case 'quote':
        html = `<blockquote>${inlineToHtml(block.content)}</blockquote>`;
        break;
      case 'codeBlock':
        html = `<pre><code>${escapeHtml(inlineToText(block.content))}</code></pre>`;
        break;
      case 'table':
        html = tableToHtml(block.content);
        break;
      case 'image':
        html = await imageToHtml(block, opts, counter);
        break;
      case 'divider':
        html = '<hr>';
        break;
      case 'file':
      case 'video':
      case 'audio': {
        const name = typeof block.props?.name === 'string' && block.props.name ? block.props.name : String(block.type);
        const href = safeHref(block.props?.url);
        html = `<p>${href ? `<a href="${escapeHtml(href)}">${escapeHtml(name)}</a>` : escapeHtml(name)}</p>`;
        break;
      }
      default: {
        // paragraph, and any block type this file has never heard of: its text is
        // still content, so it is rendered rather than dropped.
        const inner = inlineToHtml(block?.content);
        html = block?.type === 'paragraph' || inner ? `<p>${inner || '<br>'}</p>` : '';
      }
    }
    const nested = await renderBlocks(block?.children, opts, counter);
    out.push(nested ? `${html}<div class="children">${nested}</div>` : html);
    i += 1;
  }
  return out.join('\n');
}

const PRINT_CSS = `
@page { size: A4; margin: 20mm 18mm; }
* { box-sizing: border-box; }
html { font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif; font-size: 11pt; line-height: 1.5; color: #1a1a1a; }
body { margin: 0; overflow-wrap: anywhere; word-break: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.2em 0 0.4em; break-after: avoid; }
h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; } h4, h5, h6 { font-size: 11pt; }
h1.doc-title { margin-top: 0; padding-bottom: 0.3em; border-bottom: 1px solid #d0d0d0; }
p, li, blockquote { orphans: 3; widows: 3; }
p { margin: 0 0 0.6em; }
ul, ol { margin: 0 0 0.6em; padding-left: 1.6em; }
ul.check { list-style: none; padding-left: 0.4em; }
ul.check ul, ul.check ol { padding-left: 1.6em; }
.box { font-family: "Segoe UI Symbol", "Noto Sans Symbols", sans-serif; }
li { margin: 0.1em 0; }
blockquote { margin: 0 0 0.6em; padding: 0.1em 0 0.1em 0.9em; border-left: 3px solid #c8c8c8; color: #444; }
pre { margin: 0 0 0.8em; padding: 0.6em 0.8em; background: #f4f4f4; border: 1px solid #e0e0e0; border-radius: 4px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 9.5pt; line-height: 1.4; }
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; font-size: 0.92em; }
:not(pre) > code { background: #f0f0f0; padding: 0.05em 0.3em; border-radius: 3px; }
table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 0 0 0.9em; }
th, td { border: 1px solid #cfcfcf; padding: 0.3em 0.5em; text-align: left; vertical-align: top; }
th { background: #f2f2f2; font-weight: 600; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
figure { margin: 0 0 0.9em; text-align: center; break-inside: avoid; }
img { max-width: 100%; max-height: 230mm; }
figcaption { font-size: 9.5pt; color: #555; margin-top: 0.3em; }
hr { border: 0; border-top: 1px solid #c8c8c8; margin: 1.1em 0; }
a { color: #1a56b0; text-decoration: underline; }
.mention { background: #eaf0fb; color: #1a56b0; padding: 0 0.25em; border-radius: 3px; }
.children { margin-left: 1.4em; }
.missing { color: #777; font-style: italic; }
`;

export async function blocksToHtml(title: string, blocks: unknown, opts: HtmlExportOptions): Promise<HtmlExportResult> {
  const counter: Counter = { skippedImages: 0 };
  const body = await renderBlocks(blocks, opts, counter);
  const safeTitle = escapeHtml(title);
  const html =
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${safeTitle}</title>` +
    `<style>${PRINT_CSS}</style></head><body><h1 class="doc-title">${safeTitle}</h1>\n${body}\n</body></html>`;
  return { html, skippedImages: counter.skippedImages };
}
