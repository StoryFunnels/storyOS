import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EMBED_FORM } from './embed-form-type';

/**
 * #827 AC6 — the theme preview and the real embed must not be able to drift
 * apart again without a test failing.
 *
 * They used to restate the same sizes independently and diverged (preview title
 * 16px over a 12px description; real form 20px over 14px). The fix is not to match
 * the numbers but to have ONE source, so this does not compare values: it fails if
 * either consumer stops using the source, or starts carrying a size of its own.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const page = stripComments(read('../app/f/[token]/page.tsx'));
const preview = stripComments(read('../components/views/form-theme-preview.tsx'));

/** Any Tailwind font-size or spacing utility: the properties that set proportions. */
const OWN_METRIC = /\b(?:text-(?:xs|sm|base|lg|xl|2xl|3xl|title|prose|body|label|meta|micro)|(?:p|px|py|gap|space-y|leading)-[\d.[]+|font-(?:medium|semibold|bold))\b/;

describe('one source for the embedded form\'s proportions (#827)', () => {
  it('has the roles both consumers need', () => {
    expect(Object.keys(EMBED_FORM).sort()).toEqual(['control', 'description', 'field', 'form', 'help', 'label', 'submit', 'title']);
  });

  for (const role of Object.keys(EMBED_FORM) as Array<keyof typeof EMBED_FORM>) {
    it(`the real page AND the preview both use EMBED_FORM.${role}`, () => {
      expect(page, 'app/f/[token]/page.tsx').toContain(`EMBED_FORM.${role}`);
      expect(preview, 'form-theme-preview.tsx').toContain(`EMBED_FORM.${role}`);
    });
  }

  it('the preview carries NO font-size, weight or spacing class of its own', () => {
    expect(OWN_METRIC.exec(preview)?.[0], 'a size in form-theme-preview.tsx belongs in lib/embed-form-type.ts').toBeUndefined();
  });

  it('the real page does not carry a private copy of any shared value', () => {
    for (const [role, classes] of Object.entries(EMBED_FORM)) {
      // `help` is `text-label text-muted`, which the page ALSO uses, legitimately,
      // for unrelated small text ("No one to pick from"); a literal match there is
      // a coincidence of two utilities, not a restated role. The usage check above
      // still requires the page to build the help text from EMBED_FORM.help.
      if (role === 'help') continue;
      // Match the whole class attribute (`className="…"`), not a substring: `field` is
      // a prefix of an unrelated element's longer class list.
      expect(page.includes(`"${classes}"`), `app/f/[token]/page.tsx restates EMBED_FORM.${role} literally`).toBe(false);
    }
  });

  it('the preview keeps its own tiny `text-center` (alignment, not proportion), and nothing else', () => {
    expect(preview).toContain('text-center');
  });
});
