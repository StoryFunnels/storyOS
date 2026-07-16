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
type Inline = TextNode | LinkNode;
interface Block {
  type: string;
  props?: Record<string, unknown>;
  content?: Inline[];
}

// ---------- blocks → markdown ----------

function inlineToMarkdown(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((node) => {
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
      if (lm) nodes.push({ type: 'link', href: lm[2]!, content: [text(lm[1]!)] });
      else nodes.push(text(tok));
    }
    rest = rest.slice(m.index + tok.length);
  }
  return nodes;
}

/** Parse Markdown into a BlockNote document. Always returns at least one block. */
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
