/**
 * Markdown ↔ BlockNote-blocks converters for the MCP (#60). rich_text fields store a
 * BlockNote document (an array of block objects); agents think in Markdown. So on the
 * way out we render blocks as Markdown (readable) and on the way in we parse Markdown
 * into blocks (headings/lists/code/links become real structure, not one flat line).
 *
 * Self-contained on purpose: the MCP ships as its own npm package, so it can't reach
 * into the API's converter. Covers the common block + inline types; unknown blocks
 * degrade to their text.
 */

interface Styles {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
}
interface TextNode {
  type: 'text';
  text: string;
  styles?: Styles;
}
interface LinkNode {
  type: 'link';
  href: string;
  content: TextNode[];
}
/**
 * A mention (MN-205): @member or #record. Stored as a BlockNote custom inline node
 * carrying the id (the durable reference) + a label (the name/title at write time,
 * only a fallback — the editor renders the LIVE name). In Markdown it round-trips as
 * a link with a `user:`/`record:` scheme, so an agent can read AND write mentions and
 * md → blocks → md never destroys them.
 */
interface MentionNode {
  type: 'mention';
  props: { kind: 'user' | 'record'; id: string; label: string };
  content?: undefined;
}
type Inline = TextNode | LinkNode | MentionNode;
/**
 * #308 — a table block's `content` is NOT an inline array but BlockNote's
 * `tableContent` object. Shape taken from @blocknote/core 0.51.4
 * (schema/blocks/types.d.ts): rows[].cells accepts `InlineContent[][]`, and
 * `headerRows` marks how many leading rows are headers.
 */
interface TableContent {
  type: 'tableContent';
  columnWidths?: (number | undefined)[];
  headerRows?: number;
  rows: Array<{ cells: Inline[][] }>;
}
interface Block {
  type: string;
  props?: Record<string, unknown>;
  content?: Inline[] | TableContent;
  /** BlockNote nests blocks: a list item's sub-items, a toggle's body. */
  children?: Block[];
}

// ---------- blocks → markdown ----------

function inlineToMarkdown(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((node) => {
      if (node && typeof node === 'object' && (node as MentionNode).type === 'mention') {
        const p = (node as MentionNode).props ?? { kind: 'user', id: '', label: '' };
        const prefix = p.kind === 'record' ? '#' : '@';
        return `[${prefix}${p.label}](${p.kind}:${p.id})`;
      }
      if (node && typeof node === 'object' && (node as LinkNode).type === 'link') {
        const link = node as LinkNode;
        return `[${inlineToMarkdown(link.content)}](${link.href})`;
      }
      const n = node as TextNode;
      let t = typeof n?.text === 'string' ? n.text : '';
      const s = n?.styles ?? {};
      if (s.code) t = `\`${t}\``;
      if (s.bold) t = `**${t}**`;
      if (s.italic) t = `*${t}*`;
      if (s.strike) t = `~~${t}~~`;
      return t;
    })
    .join('');
}

/** A cell's text, with pipes escaped so a value containing "|" can't fake a column. */
function cellToMarkdown(cell: Inline[]): string {
  return inlineToMarkdown(cell).replace(/\|/g, '\\|').trim();
}

/**
 * #308 — a BlockNote table → GFM. Emitted with a header row and the `|---|`
 * separator so it round-trips back through markdownToBlocks into the same table.
 * A table with no `headerRows` still gets its first row treated as the header,
 * because GFM has no way to express a header-less table.
 */
function tableToMarkdown(content: TableContent): string {
  const rows = Array.isArray(content?.rows) ? content.rows : [];
  if (rows.length === 0) return '';
  const cols = Math.max(...rows.map((r) => (Array.isArray(r?.cells) ? r.cells.length : 0)), 1);
  const line = (cells: Inline[][]) => {
    const out: string[] = [];
    for (let c = 0; c < cols; c++) out.push(cellToMarkdown(cells[c] ?? []));
    return `| ${out.join(' | ')} |`;
  };
  const lines = [line(rows[0]!.cells ?? [])];
  lines.push(`| ${Array.from({ length: cols }, () => '---').join(' | ')} |`);
  for (const row of rows.slice(1)) lines.push(line(row?.cells ?? []));
  return lines.join('\n');
}

const LIST_TYPES = new Set(['bulletListItem', 'numberedListItem', 'checkListItem']);
/** Blocks that render as a Markdown list item, and so nest their children by marker width. */
const LIST_LIKE = new Set([...LIST_TYPES, 'toggleListItem']);
/** Beyond this a document is malformed or hostile; flatten rather than overflow the stack. */
const MAX_NESTING = 64;

/** Every descendant of `blocks` in document order, with their own `children` removed.
 * Iterative on purpose: this is the path for a tree too deep to recurse into. */
function flattenSubtree(blocks: unknown[]): Block[] {
  const out: Block[] = [];
  const stack: unknown[] = [...blocks].reverse();
  while (stack.length > 0) {
    const block = stack.pop() as Block;
    out.push({ ...block, children: [] });
    const kids = Array.isArray(block.children) ? (block.children as unknown[]) : [];
    for (let k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
  }
  return out;
}

/** Indent every non-empty line (blank lines stay blank, so no trailing whitespace). */
function indentLines(md: string, indent: string): string {
  if (!indent) return md;
  return md
    .split('\n')
    .map((l) => (l ? indent + l : l))
    .join('\n');
}

/** A URL that survives `![..](url)`: the parser's URL group stops at whitespace or ")". */
function markdownUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/** Alt/label text: no brackets (they would end the link early) and no line breaks. */
function markdownLabel(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

/** One block's own Markdown, WITHOUT its children (renderBlocks adds those). */
function ownMarkdown(block: Block, ordinal: number): string {
  const text = inlineToMarkdown(block.content);
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(block.props?.level ?? 1))))} ${text}`;
    case 'bulletListItem':
      return `- ${text}`;
    case 'numberedListItem':
      return `${ordinal}. ${text}`;
    case 'checkListItem':
      return `- [${block.props?.checked ? 'x' : ' '}] ${text}`;
    // #822: a toggle has no Markdown form, so it is a bullet — its TITLE and (via
    // renderBlocks) its BODY survive, as a nested list. The type is lost; the
    // content, which used to vanish entirely, is not.
    case 'toggleListItem':
      return `- ${text}`;
    case 'quote':
      return `> ${text}`;
    case 'codeBlock': {
      const lang = typeof block.props?.language === 'string' ? block.props.language : '';
      return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
    // #308: without this a table serialised to its bare text and was lost on the
    // way OUT too — a table made in the editor never survived being read back.
    case 'table':
      return tableToMarkdown(block.content as TableContent);
    // #822: images, dividers and files used to serialise to nothing at all.
    case 'image': {
      const url = markdownUrl(block.props?.url);
      // Never `![](...)` with no URL, and never an empty image: emit nothing.
      if (!url) return '';
      return `![${markdownLabel(block.props?.caption) || markdownLabel(block.props?.name)}](${url})`;
    }
    case 'divider':
      return '---';
    case 'file':
    case 'video':
    case 'audio': {
      const url = markdownUrl(block.props?.url);
      if (!url) return '';
      return `[${markdownLabel(block.props?.caption) || markdownLabel(block.props?.name) || url}](${url})`;
    }
    default:
      return text;
  }
}

function renderBlocks(blocks: unknown[], depth: number): string {
  let result = '';
  let ordinal = 0; // running number for consecutive numbered-list items
  blocks.forEach((raw, idx) => {
    const block = raw as Block;
    ordinal = block.type === 'numberedListItem' ? ordinal + 1 : 0;
    let md = ownMarkdown(block, ordinal);

    // #822: descend into children. Before this, only a block's own `content` was
    // read, so anything nested — and a toggle's whole body — silently vanished.
    const children = Array.isArray(block.children) ? (block.children as unknown[]) : [];
    if (children.length > 0) {
      // Past MAX_NESTING the subtree is flattened into one level instead of recursed into:
      // depth is given up, content is not.
      const rendered = renderBlocks(depth < MAX_NESTING ? children : flattenSubtree(children), depth + 1);
      if (LIST_LIKE.has(block.type)) {
        // Nest at the parent's marker width (CommonMark): `- ` is 2, `1. ` is 3, `10. ` is 4.
        const width = block.type === 'numberedListItem' ? `${ordinal}. `.length : 2;
        const firstChild = (children[0] as Block).type;
        // A sub-item continues the list on the next line; anything else needs a blank line first.
        md += (LIST_LIKE.has(firstChild) ? '\n' : '\n\n') + indentLines(rendered, ' '.repeat(width));
      } else {
        // Markdown cannot express a child of a paragraph/heading/quote. Keep the CONTENT
        // after it at the same level and say so: depth is lost there, content is not.
        md += '\n\n' + rendered;
      }
    }

    if (idx > 0) {
      // Keep adjacent list items on consecutive lines; blank line between other blocks.
      const prevType = (blocks[idx - 1] as Block).type;
      result += prevType === block.type && LIST_TYPES.has(block.type) ? '\n' : '\n\n';
    }
    result += md;
  });
  return result;
}

/** Render a BlockNote document (or a stray string) as Markdown. */
export function blocksToMarkdown(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return renderBlocks(blocks, 0);
}

// ---------- markdown → blocks ----------

function text(value: string, styles?: Styles): TextNode {
  return styles ? { type: 'text', text: value, styles } : { type: 'text', text: value, styles: {} };
}

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(~~[^~]+~~)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/;

/** Parse a single line of Markdown inline syntax (non-nested) into inline nodes. */
function parseInline(input: string): Inline[] {
  const nodes: Inline[] = [];
  let rest = input;
  while (rest.length) {
    const m = INLINE_RE.exec(rest);
    if (!m) {
      nodes.push(text(rest));
      break;
    }
    if (m.index > 0) nodes.push(text(rest.slice(0, m.index)));
    const tok = m[0];
    if (tok.startsWith('`')) nodes.push(text(tok.slice(1, -1), { code: true }));
    else if (tok.startsWith('**')) nodes.push(text(tok.slice(2, -2), { bold: true }));
    else if (tok.startsWith('~~')) nodes.push(text(tok.slice(2, -2), { strike: true }));
    else if (tok.startsWith('*')) nodes.push(text(tok.slice(1, -1), { italic: true }));
    else {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (lm) {
        const label = lm[1]!;
        const href = lm[2]!;
        // A user:/record: scheme is a mention, not a plain link (MN-205).
        const scheme = href.match(/^(user|record):(.+)$/);
        if (scheme) {
          const kind = scheme[1] as 'user' | 'record';
          const bare = label.replace(kind === 'record' ? /^#/ : /^@/, '');
          nodes.push({ type: 'mention', props: { kind, id: scheme[2]!, label: bare } });
        } else {
          nodes.push({ type: 'link', href, content: [text(label)] });
        }
      } else nodes.push(text(tok));
    }
    rest = rest.slice(m.index + tok.length);
  }
  return nodes;
}

/** Parse Markdown into a BlockNote document. Always returns at least one block. */
/** Split a GFM table row on unescaped pipes, dropping the outer delimiters. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|'; // an escaped pipe is DATA, not a column break
      i++;
    } else if (ch === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  // A GFM row is conventionally wrapped in pipes, which yields empty first/last
  // parts — drop those, not genuinely empty interior cells.
  if (cells.length && cells[0]!.trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

/** `|---|:--:|` — the separator line that makes the line above it a header row. */
function isSeparatorRow(line: string): boolean {
  if (!line.includes('-') || !line.includes('|')) return false;
  const parts = splitRow(line);
  return parts.length > 0 && parts.every((p) => /^:?-{1,}:?$/.test(p));
}

/** A line that is only `![alt](url)` — an image BLOCK. One inside a sentence stays text. */
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/;
const RULE_RE = /^(-{3,}|\*{3,}|_{3,})$/;

/** Leading indentation, a tab counting as four spaces. */
function leadingSpaces(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === ' ') n++;
    else if (ch === '\t') n += 4;
    else break;
  }
  return n;
}

/** Strip up to `n` columns of leading whitespace (used to dedent a nested code fence's body). */
function dedent(line: string, n: number): string {
  let cut = 0;
  let cols = 0;
  while (cut < line.length && cols < n && (line[cut] === ' ' || line[cut] === '\t')) {
    cols += line[cut] === '\t' ? 4 : 1;
    cut++;
  }
  return line.slice(cut);
}

export function markdownToBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  // #822: list items still open, shallowest first, each with the column its marker
  // sat in. Depth comes from THIS stack, not a fixed indent width, so 2-space, 3-space
  // and 4-space nesting all read back as nesting.
  const open: Array<{ lead: number; block: Block }> = [];
  const place = (block: Block, lead: number, isList = false) => {
    while (open.length > 0 && open[open.length - 1]!.lead >= lead) open.pop();
    const parent = open[open.length - 1];
    if (parent) (parent.block.children ??= []).push(block);
    else blocks.push(block);
    if (isList) open.push({ lead, block });
  };
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;

    if (raw.trim() === '') {
      i++;
      continue;
    }

    // An indented line nests only when a list item is open ABOVE it. With none, it stays
    // exactly what it always was — a literal-text paragraph — so this cannot change how a
    // document that never nested is read.
    let lead = leadingSpaces(raw);
    const nested = lead > 0 && open.some((e) => e.lead < lead);
    const line = nested ? raw.trimStart() : raw;
    if (!nested) lead = 0;

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const code: string[] = [];
      const closing = nested ? /^\s*```\s*$/ : /^```\s*$/;
      i++;
      while (i < lines.length && !closing.test(lines[i]!)) {
        code.push(nested ? dedent(lines[i]!, lead) : lines[i]!);
        i++;
      }
      i++; // consume closing fence
      place(
        {
          type: 'codeBlock',
          props: fence[1] ? { language: fence[1] } : {},
          content: [text(code.join('\n'))],
        },
        lead,
      );
      continue;
    }

    // #308 — a GFM table: a pipe row followed by a |---| separator. Checked BEFORE
    // the single-line matchers, because otherwise every row falls through to the
    // paragraph default and the table becomes a stack of pipe characters.
    // Requiring the separator is what keeps an ordinary sentence containing "|"
    // (or a line of inline code) a paragraph.
    if (line.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1]!)) {
      const header = splitRow(line);
      const cols = header.length;
      const rows: Array<{ cells: Inline[][] }> = [
        { cells: header.map((c) => parseInline(c)) },
      ];
      i += 2; // consume the header and the separator
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        const cells = splitRow(lines[i]!);
        // Ragged rows are padded/truncated to the header width rather than
        // rejected — a half-written table should still render as a table.
        const padded: Inline[][] = [];
        for (let c = 0; c < cols; c++) padded.push(parseInline(cells[c] ?? ''));
        rows.push({ cells: padded });
        i++;
      }
      place(
        {
          type: 'table',
          content: {
            type: 'tableContent',
            columnWidths: Array.from({ length: cols }, () => undefined),
            headerRows: 1,
            rows,
          },
        },
        lead,
      );
      continue;
    }

    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      place({ type: 'heading', props: { level: m[1]!.length }, content: parseInline(m[2]!) }, lead);
    } else if ((m = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/))) {
      place({ type: 'checkListItem', props: { checked: m[1]!.toLowerCase() === 'x' }, content: parseInline(m[2]!) }, lead, true);
    } else if ((m = line.match(/^[-*+]\s+(.*)$/))) {
      place({ type: 'bulletListItem', content: parseInline(m[1]!) }, lead, true);
    } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      place({ type: 'numberedListItem', content: parseInline(m[1]!) }, lead, true);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      place({ type: 'quote', content: parseInline(m[1]!) }, lead);
    } else if (RULE_RE.test(line.trim())) {
      // #822: this branch used to SKIP the rule ("BlockNote core has no HR block").
      // It does — `divider`, in BlockNote 0.51.4's default blocks — so a rule is now
      // kept, which is also what makes blocksToMarkdown's `---` round-trip.
      place({ type: 'divider' }, lead);
    } else if ((m = line.trim().match(IMAGE_LINE_RE))) {
      place({ type: 'image', props: { url: m[2]!, caption: m[1]! } }, lead);
    } else {
      place({ type: 'paragraph', content: parseInline(line) }, lead);
    }
    i++;
  }
  return blocks.length ? blocks : [{ type: 'paragraph', content: [] }];
}
