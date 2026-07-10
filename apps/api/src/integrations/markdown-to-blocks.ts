/**
 * Minimal markdown → BlockNote block JSON, for importers (MN-070). Covers the
 * common subset issue trackers emit: headings, bullet/numbered/checkbox lists,
 * fenced code, blockquotes, horizontal rules, paragraphs — with inline bold,
 * italic, inline code and links. Not a full CommonMark parser; unknown syntax
 * degrades to plain text so nothing is ever lost.
 *
 * Blocks are id-less PartialBlocks: BlockNote assigns ids on load.
 */

type Styles = { bold?: true; italic?: true; code?: true };
type InlineText = { type: 'text'; text: string; styles: Styles };
type InlineLink = { type: 'link'; href: string; content: InlineText[] };
type Inline = InlineText | InlineLink;
export interface Block {
  type: string;
  props?: Record<string, unknown>;
  content?: Inline[] | string;
  children?: Block[];
}

/** Parse a single line of inline markdown into text/link runs. */
function parseInline(text: string): InlineText[] | Inline[] {
  const out: Inline[] = [];
  // Links first: [label](url). Everything between is styled text.
  const linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > last) out.push(...styleRuns(text.slice(last, m.index)));
    out.push({ type: 'link', href: m[2]!, content: styleRuns(m[1]!) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...styleRuns(text.slice(last)));
  return out.length > 0 ? out : [{ type: 'text', text: '', styles: {} }];
}

/** Split a plain string into styled text runs (bold / italic / code). */
function styleRuns(input: string): InlineText[] {
  const runs: InlineText[] = [];
  // Order matters: code spans are literal, so pull them first.
  const tokenRe = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/;
  let rest = input;
  while (rest.length > 0) {
    const m = tokenRe.exec(rest);
    if (!m) {
      runs.push({ type: 'text', text: rest, styles: {} });
      break;
    }
    if (m.index > 0) runs.push({ type: 'text', text: rest.slice(0, m.index), styles: {} });
    const tok = m[0];
    if (tok.startsWith('`')) runs.push({ type: 'text', text: tok.slice(1, -1), styles: { code: true } });
    else if (tok.startsWith('**') || tok.startsWith('__')) runs.push({ type: 'text', text: tok.slice(2, -2), styles: { bold: true } });
    else runs.push({ type: 'text', text: tok.slice(1, -1), styles: { italic: true } });
    rest = rest.slice(m.index + tok.length);
  }
  return runs.length > 0 ? runs : [{ type: 'text', text: input, styles: {} }];
}

export function markdownToBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (trimmed === '') {
      i++;
      continue;
    }

    // Fenced code block
    const fence = /^```(\w*)\s*$/.exec(trimmed);
    if (fence) {
      const lang = fence[1] || undefined;
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!.trim())) {
        code.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      blocks.push({ type: 'codeBlock', props: lang ? { language: lang } : {}, content: code.join('\n') });
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      blocks.push({ type: 'paragraph', content: [] });
      i++;
      continue;
    }

    // Heading
    const heading = /^(#{1,3})\s+(.*)$/.exec(trimmed);
    if (heading) {
      blocks.push({ type: 'heading', props: { level: heading[1]!.length }, content: parseInline(heading[2]!) as Inline[] });
      i++;
      continue;
    }

    // Blockquote (collapse consecutive > lines into paragraphs)
    if (/^>\s?/.test(trimmed)) {
      blocks.push({ type: 'paragraph', content: parseInline(trimmed.replace(/^>\s?/, '')) as Inline[] });
      i++;
      continue;
    }

    // Checkbox list item
    const check = /^[-*]\s+\[([ xX])\]\s+(.*)$/.exec(trimmed);
    if (check) {
      blocks.push({
        type: 'checkListItem',
        props: { checked: check[1]!.toLowerCase() === 'x' },
        content: parseInline(check[2]!) as Inline[],
      });
      i++;
      continue;
    }

    // Bullet list item
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      blocks.push({ type: 'bulletListItem', content: parseInline(bullet[1]!) as Inline[] });
      i++;
      continue;
    }

    // Numbered list item
    const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      blocks.push({ type: 'numberedListItem', content: parseInline(numbered[1]!) as Inline[] });
      i++;
      continue;
    }

    // Paragraph: gather consecutive non-blank, non-special lines
    const para: string[] = [line];
    i++;
    while (i < lines.length) {
      const next = lines[i]!.trim();
      if (
        next === '' ||
        /^```/.test(next) ||
        /^#{1,3}\s/.test(next) ||
        /^[-*+]\s/.test(next) ||
        /^\d+[.)]\s/.test(next) ||
        /^>\s?/.test(next) ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(next)
      ) {
        break;
      }
      para.push(lines[i]!);
      i++;
    }
    blocks.push({ type: 'paragraph', content: parseInline(para.join(' ').trim()) as Inline[] });
  }

  return blocks;
}
