import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #801 — a name the user must retype has to be copyable, and a label is where it
 * stops being so: a label's click moves focus to its control, which collapses a
 * drag-selection of the label's own text (measured live). Three dialogs each wrote
 * the prompt by hand, one "fixed" it by adding `htmlFor` (which changes nothing),
 * and a comment claiming the name was outside the label sat above code that kept
 * it inside. So the prompt is one component (`TypedConfirmName`), and this guard
 * refuses the shape that failed: a "Type <something> to confirm" sentence written
 * inside a <label>/<Label>.
 *
 * Source-shape only: it cannot see selection behaviour, which was verified live.
 */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : tsxFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

describe('typed-confirmation prompts', () => {
  it('never put the name to retype inside a label', () => {
    const root = join(__dirname, '..');
    const offenders: string[] = [];
    for (const file of tsxFiles(root)) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/<(?:label|Label)\b[^>]*>([\s\S]*?)<\/(?:label|Label)>/g)) {
        if (/\bType\b[\s\S]*\{[^}]*(?:requireTyped|\bname\b|\btarget\b)[^}]*\}[\s\S]*to confirm/.test(m[1] ?? '')) {
          offenders.push(file.replace(root, 'src'));
        }
      }
    }
    expect(offenders, 'use <TypedConfirmName name={…} /> instead of a label').toEqual([]);
  });
});
