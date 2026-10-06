import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #808 finding three — a banner read "Created atis recorded automatically".
 *
 * The source was `{dateField.displayName} is recorded automatically and
 * can&apos;t be edited — …`, with a plain space after the `}`. The COMPILED
 * output was `[name, "is recorded automatically and can't …"]`: the space was
 * gone, so the two words ran together on screen while the source looked right.
 * Three sites carried the same shape (calendar, timeline, board). The common
 * ingredient is an HTML entity in the text that follows the expression, so that
 * is the pattern this guard refuses; write such a sentence as one template
 * string instead, which no whitespace rule can touch.
 *
 * A source-shape guard, deliberately narrow: it cannot see the compiler, only
 * the combination that was shown to break.
 */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : tsxFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

// `} word … &entity;` on one JSX text line, with no tag or brace between.
const SUSPECT = /\}[ ]+[A-Za-z][^<>{}\n]*&(?:apos|rsquo|lsquo|quot|ldquo|rdquo|mdash|ndash|nbsp|amp);/;

describe('JSX text after an expression', () => {
  it('never combines a following space with an HTML entity in the same text', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(join(__dirname, '..'))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (SUSPECT.test(line) && !line.trimStart().startsWith('//') && !line.includes('className=')) {
            offenders.push(`${file.replace(join(__dirname, '..'), 'src')}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(offenders, `write these as a template string:\n${offenders.join('\n')}`).toEqual([]);
  });
});
