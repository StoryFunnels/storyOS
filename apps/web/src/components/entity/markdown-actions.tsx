'use client';

import { useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { toast } from 'sonner';

/** Minimal structural type — BlockNote's editor exposes this (#74). Some versions
 * return a string, others a Promise; `await` handles both. */
interface MarkdownSource {
  blocksToMarkdownLossy: () => string | Promise<string>;
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'document'
  );
}

/**
 * Copy / download a rich-text field or document as Markdown (#74). Pairs with the
 * MCP Markdown round-trip (#60): what an agent reads is what you can copy out here.
 */
export function MarkdownActions({ editor, filename }: { editor: MarkdownSource; filename: string }) {
  const [copied, setCopied] = useState(false);

  const toMarkdown = async () => editor.blocksToMarkdownLossy();

  const flash = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  /** execCommand fallback — the async Clipboard API needs a focused document and a
   * secure context, so it can be unavailable even when copying is perfectly fine. */
  const copyFallback = (text: string): boolean => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  };

  const copy = async () => {
    const md = await toMarkdown();
    try {
      await navigator.clipboard.writeText(md);
      flash();
    } catch {
      if (copyFallback(md)) flash();
      else toast.error('Could not copy');
    }
  };

  const download = async () => {
    try {
      const blob = new Blob([await toMarkdown()], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slugify(filename)}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Could not download');
    }
  };

  return (
    <span className="flex items-center gap-0.5">
      <button
        type="button"
        title={copied ? 'Copied' : 'Copy as Markdown'}
        onClick={copy}
        className="rounded p-1 text-faint hover:bg-hover hover:text-ink"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        title="Download as .md"
        onClick={download}
        className="rounded p-1 text-faint hover:bg-hover hover:text-ink"
      >
        <Download className="h-3.5 w-3.5" />
      </button>
    </span>
  );
}
