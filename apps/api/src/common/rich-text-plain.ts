/**
 * A rich_text field's value is an array of BlockNote blocks (`[{ type: 'paragraph', content: [{ type: 'text', text, styles }] }]`).
 * `{Field}` in an automation template used to render such a value through the generic "array of things with a title" rule, which has no
 * title to find in a block, so the token rendered as the EMPTY STRING (ticket #456: the Social Command Center's Text field, so a publish
 * rule pre-filled with `{Text}` would have posted nothing).
 *
 * Plain text, not Markdown: the places a template lands (a social post, an email subject, a Slack line) do not render Markdown. Blocks are
 * separated by a newline, inline pieces are joined with nothing (so "bold" + " text" stays one word run), and nested children follow their parent.
 */
export function isRichTextBlocks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((b) => typeof b === 'object' && b !== null && typeof (b as { type?: unknown }).type === 'string' && ('content' in b || 'children' in b || 'props' in b))
  );
}

export function richTextBlocksToPlain(blocks: unknown): string {
  const inline = (nodes: unknown): string => {
    if (!Array.isArray(nodes)) return typeof nodes === 'string' ? nodes : '';
    return nodes
      .map((n) => {
        if (typeof n === 'string') return n;
        if (typeof n !== 'object' || n === null) return '';
        const node = n as { text?: unknown; content?: unknown };
        if (typeof node.text === 'string') return node.text;
        return inline(node.content);
      })
      .join('');
  };
  const lines: string[] = [];
  const walk = (nodes: unknown[]) => {
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const block = node as { content?: unknown; children?: unknown };
      lines.push(inline(block.content));
      if (Array.isArray(block.children)) walk(block.children);
    }
  };
  if (Array.isArray(blocks)) walk(blocks);
  return lines.join('\n').trim();
}
