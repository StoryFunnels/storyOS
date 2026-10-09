import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #833 AC6 — there is no in-app "Run" for a skill, and the reason is written in
 * skills-library.tsx where someone would add one. A comment can be ignored; this
 * cannot: it reads every source file on the Skills surface and fails if one
 * calls the run endpoint or offers a Run button.
 *
 * Scope is the surface's own files (components/skills and the three route
 * pages), NOT the whole app: AI fields and automations legitimately run things.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const pagesDir = fileURLToPath(new URL('../../app/w/[ws]/skills', import.meta.url));
// #866 — the public page is part of the Skills surface: it must never offer a Run either.
const publicPageDir = fileURLToPath(new URL('../../app/s', import.meta.url));

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push({ file: full, text: readFileSync(full, 'utf8') });
  }
  return out;
}

const surface = [...sources(here), ...sources(pagesDir), ...sources(publicPageDir)];

/** Strip comments, so the explanatory note above SkillRow (which names the run
 * endpoint on purpose) does not trip the guard that protects it. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the Skills surface offers no Run (ticket #833 AC6)', () => {
  it('has files to check', () => {
    expect(surface.length).toBeGreaterThanOrEqual(6);
  });
  it('never calls the run endpoint', () => {
    for (const { file, text } of surface) {
      expect(code(text), file).not.toMatch(/skills\/\{id\}\/run|\/skills\/[^'"`]*\/run/);
    }
  });
  it('never renders a Run / Execute / Try-it control', () => {
    for (const { file, text } of surface) {
      expect(code(text), file).not.toMatch(/>\s*(Run|Run skill|Execute|Try it)\s*</i);
    }
  });
  it('keeps the reason where someone would add the button', () => {
    const lib = surface.find((s) => s.file.endsWith('skills-library.tsx'))!;
    expect(lib.text).toMatch(/AC6/);
    expect(lib.text).toMatch(/NOT A GAP/);
  });
});

describe('allowed_tools is off the surface (ticket #833 amended AC2)', () => {
  it('is neither authored nor displayed by any file on the surface', () => {
    for (const { file, text } of surface) {
      // Mentioned only in comments explaining its absence; never in code.
      expect(code(text), file).not.toMatch(/allowed_tools|allowedTools|Allowed tools/);
    }
  });
});

describe('the picker keeps each tier’s detail under that tier, and a read-only viewer cannot click (ticket #833 polish)', () => {
  const editor = surface.find((s) => s.file.endsWith('skill-editor.tsx'))!;
  it('renders the member list and the public link inside the option loop, not after it', () => {
    const t = code(editor.text);
    const loop = t.slice(t.indexOf('VISIBILITY_OPTIONS.map'), t.indexOf('</fieldset>'));
    expect(loop).toMatch(/<MemberPicker/);
    expect(loop).toMatch(/<PublicLink/);
  });
  it('disables the radios and drops the pointer cursor for a read-only viewer', () => {
    const t = code(editor.text);
    expect(t).toMatch(/disabled=\{readOnly\}\s+checked=/);
    expect(t).toMatch(/readOnly \? 'cursor-not-allowed/);
  });
});

describe('the import dialog does not show the native file control (ticket #833 polish)', () => {
  it('uses a hidden input driven by an app button', () => {
    const dialog = surface.find((s) => s.file.endsWith('skill-import-dialog.tsx'))!;
    const t = code(dialog.text);
    expect(t).toMatch(/type="file"[\s\S]{0,200}sr-only/);
    expect(t).toMatch(/Choose file…/);
  });
});

describe('the public skill page (ticket #866)', () => {
  const page = surface.find((s) => s.file.endsWith(join('s', '[token]', 'page.tsx')))!;
  const notFound = surface.find((s) => s.file.endsWith(join('s', '[token]', 'not-found.tsx')))!;
  it('is part of the checked surface', () => {
    expect(page).toBeTruthy();
    expect(notFound).toBeTruthy();
  });
  it('keeps the no-Run reason where someone would add the button', () => {
    expect(page.text).toMatch(/THERE IS NO RUN BUTTON HERE/);
  });
  it('is not indexable, for a live token and an unknown one alike', () => {
    expect(page.text).toMatch(/index: false, follow: false/);
    expect(code(page.text).match(/robots/g)!.length).toBeGreaterThanOrEqual(3);
  });
  it('answers an unknown, malformed or revoked token with the same not-found, and never says which', () => {
    expect(code(page.text)).toMatch(/if \(!skill\) notFound\(\)/);
    expect(code(notFound.text)).not.toMatch(/revoked|expired|deleted|never existed/i);
  });
  it('a server failure is not shown as "not found"', () => {
    expect(code(page.text)).toMatch(/throw new Error\(`public skill read failed/);
  });
});

describe('what the public skill page must NOT carry (ticket #866 AC8)', () => {
  const page = surface.find((s) => s.file.endsWith(join('s', '[token]', 'page.tsx')))!;
  const body = code(page.text);
  it('declares exactly the portable fields, and nothing identifying', () => {
    const iface = body.slice(body.indexOf('interface PublicSkill'), body.indexOf('async function getSkill'));
    const keys = [...iface.matchAll(/^\s+([a-z_]+)\??:/gm)].map((m) => m[1]).sort();
    expect(keys).toEqual(['description', 'examples', 'instructions', 'name', 'updated_at', 'version', 'when_to_use']);
  });
  it('never reads an identifier off the skill', () => {
    expect(body).not.toMatch(/\b(workspace_id|owner_id|member_ids|public_token|source_template|last_run|\.id\b|author|published_by)\b/);
  });
  it('shows no publisher, and nothing in its place', () => {
    expect(body).not.toMatch(/published by|shared by|written by|author|owner/i);
  });
});
