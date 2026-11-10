import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COPY, SUPPORTED_TOOLS } from './words';

/**
 * Ticket #1249 — Runner copy promised "Claude Code or Cursor" while only Claude Code runs agents (the Cursor adapter is ticket #1136).
 * Nothing failed to compile when it drifted, so this fails instead.
 *
 * The scope is DERIVED, not listed: every non-test source file under ANY directory named `runners` inside apps/web/src, so a new
 * Runner component or a second copy of the page is covered the day it exists. (A hand-listed set of files is how the first three
 * places were found but a fourth, words.ts and runs-on-line.tsx, was missed.)
 */
/** The tool's name in prose, or its id as a string literal. Case-sensitive on purpose: `next_cursor` and `cursor-pointer` are pagination and CSS. */
const MENTIONS_CURSOR = /Cursor|['"`]cursor['"`]/;
const SRC = join(__dirname, '..', '..');

function runnerSources(dir: string, inRunners = false): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return runnerSources(p, inRunners || name === 'runners');
    return inRunners && /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/**
 * Files that legitimately name Cursor because they map a tool id a Runner REPORTED to its display name or capabilities. That is
 * data-driven, not a promise of support. Each is asserted below to still contain "Cursor", so an entry cannot outlive its reason.
 */
const REPORTED_TOOL_FILES: Record<string, string> = {
  'lib/runners/words.ts': 'toolName / limitBrand: display name of a tool id the Runner reported',
  'lib/runners/types.ts': 'KnownToolId: the ids the API may report',
  'lib/runners/agent-settings.ts': 'modelControllable: a chosen tool of "cursor" cannot pick a model',
  'components/runners/agent-advanced.tsx': 'model control text when the assigned tool is Cursor',
};

describe('Runner copy names only the tool that runs today (ticket #1249)', () => {
  const files = runnerSources(SRC);
  const rel = (f: string) => relative(SRC, f).split('\\').join('/');

  it('finds the directories (guards against a scan that silently matches nothing)', () => {
    expect(files.map(rel)).toEqual(expect.arrayContaining(['lib/runners/words.ts', 'components/runners/pairing-card.tsx', 'app/w/[ws]/settings/runners/page.tsx']));
    expect(files.length).toBeGreaterThan(20);
  });

  it('no Runner source outside the reported-tool files mentions Cursor', () => {
    const offenders = files.filter((f) => !(rel(f) in REPORTED_TOOL_FILES) && MENTIONS_CURSOR.test(readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('no Runner copy anywhere offers a choice of tools ("Claude Code or ...")', () => {
    const offenders = files.filter((f) => /Claude Code (or|and) /.test(readFileSync(f, 'utf8')));
    expect(offenders.map(rel)).toEqual([]);
  });

  it('each reported-tool exception still has its reason', () => {
    for (const k of Object.keys(REPORTED_TOOL_FILES)) expect(readFileSync(join(SRC, k), 'utf8'), k).toMatch(MENTIONS_CURSOR);
  });

  it('the shared phrase is Claude Code only and feeds the pinned copy', () => {
    expect(SUPPORTED_TOOLS).toBe('Claude Code');
    expect(COPY.firstRun).toContain(SUPPORTED_TOOLS);
    expect(COPY.runnersLead).toContain(SUPPORTED_TOOLS);
    expect(`${COPY.firstRun} ${COPY.runnersLead}`).not.toMatch(MENTIONS_CURSOR);
  });
});
