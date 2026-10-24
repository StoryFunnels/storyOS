import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1057 — nothing on a customer-facing screen may carry the team's own words. The page that prompted this shipped
 * "Draft a ticket for: the sidebar caret is too small on phones" as an example prompt: our dogfooding, in a customer's face,
 * and in the marketing screenshots of that page.
 *
 * What this scans is the CODE of apps/web/src with comments removed, because the names legitimately appear in comments
 * that explain why something is the way it is; what remains is string literals and JSX text, i.e. what a person can read.
 * Each pattern says what it is looking for, so a hit is a decision rather than a puzzle.
 */
const SRC = join(__dirname, '..');
const INTERNAL: Array<[RegExp, string]> = [
  [/\b(Iris|Marek|Vera|Otto|Dara|Illia)\b/, 'a teammate or agent of ours by name'],
  [/storyos-envs|storyos-agent-plans/, 'a path on our machines'],
  [/sidebar caret/i, 'the dogfooding prompt this ticket removed'],
  [/\bticket #\d+/i, 'a ticket reference'],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

// Block comments (a JSX comment is one too) and line comments, but never the double slash of a URL.
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');
}

describe('no internal words on customer-facing screens (#1057)', () => {
  it('the comment stripper keeps strings and URLs and drops comments', () => {
    const out = stripComments("const a = 'https://x.dev/Iris'; // Iris\n{/* Marek */}\nconst b = \"Vera\"; /* Otto */");
    expect(out).toContain("'https://x.dev/Iris'");
    expect(out).toContain('"Vera"');
    expect(out).not.toMatch(/Marek|Otto|\/\/ Iris/);
  });

  for (const [pattern, why] of INTERNAL) {
    it(`no string or text matches ${pattern} (${why})`, () => {
      const hits: string[] = [];
      for (const file of walk(SRC)) {
        const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          if (pattern.test(line)) hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }
});
