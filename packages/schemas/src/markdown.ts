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

/** Render a BlockNote document (or a stray string) as Markdown. */
export function blocksToMarkdown(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  let result = '';
  let ordinal = 0; // running number for consecutive numbered-list items
  blocks.forEach((raw, idx) => {
    const block = raw as Block;
    const text = inlineToMarkdown(block.content);
    ordinal = block.type === 'numberedListItem' ? ordinal + 1 : 0;
    let md: string;
    switch (block.type) {
      case 'heading':
        md = `${'#'.repeat(Math.min(6, Math.max(1, Number(block.props?.level ?? 1))))} ${text}`;
        break;
      case 'bulletListItem':
        md = `- ${text}`;
        break;
      case 'numberedListItem':
        md = `${ordinal}. ${text}`;
        break;
      case 'checkListItem':
        md = `- [${block.props?.checked ? 'x' : ' '}] ${text}`;
        break;
      case 'quote':
        md = `> ${text}`;
        break;
      case 'codeBlock': {
        const lang = typeof block.props?.language === 'string' ? block.props.language : '';
        md = `\`\`\`${lang}\n${text}\n\`\`\``;
        break;
      }
      // #308: without this a table serialised to its bare text and was lost on the
      // way OUT too — a table made in the editor never survived being read back.
      case 'table':
        md = tableToMarkdown(block.content as TableContent);
        break;
      default:
        md = text;
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

export function markdownToBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) {
        code.push(lines[i]!);
        i++;
      }
      i++; // consume closing fence
      blocks.push({
        type: 'codeBlock',
        props: fence[1] ? { language: fence[1] } : {},
        content: [text(code.join('\n'))],
      });
      continue;
    }

    if (line.trim() === '') {
      i++;
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
      blocks.push({
        type: 'table',
        content: {
          type: 'tableContent',
          columnWidths: Array.from({ length: cols }, () => undefined),
          headerRows: 1,
          rows,
        },
      });
      continue;
    }

    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      blocks.push({ type: 'heading', props: { level: m[1]!.length }, content: parseInline(m[2]!) });
    } else if ((m = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/))) {
      blocks.push({ type: 'checkListItem', props: { checked: m[1]!.toLowerCase() === 'x' }, content: parseInline(m[2]!) });
    } else if ((m = line.match(/^[-*+]\s+(.*)$/))) {
      blocks.push({ type: 'bulletListItem', content: parseInline(m[1]!) });
    } else if ((m = line.match(/^\d+\.\s+(.*)$/))) {
      blocks.push({ type: 'numberedListItem', content: parseInline(m[1]!) });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      blocks.push({ type: 'quote', content: parseInline(m[1]!) });
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      // horizontal rule — BlockNote core has no HR block; skip it.
    } else {
      blocks.push({ type: 'paragraph', content: parseInline(line) });
    }
    i++;
  }
  return blocks.length ? blocks : [{ type: 'paragraph', content: [] }];
}
