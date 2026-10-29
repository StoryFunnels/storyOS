import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1163 — GOLD MARKS AGENTS: where they live, who they are, what they are doing, and what they are asking of you.
 * Not AI as a topic, not favourites, not selection, not toggles, not human tasks, not setup nudges. (Dara's rule.)
 *
 * Why the forbidden set is DERIVED, not listed (CLAUDE.md "a check wrong about what it checks"): the gold tokens are read
 * out of globals.css (every `--accent*` / `--text-on-accent` custom property, and every `--color-*` Tailwind alias that
 * resolves to one), and the usage patterns are built from those names, so a new `--accent-foo` token is covered the day
 * it is declared. The allow-list below is by file and by COUNT: a file may paint gold in exactly the agent places Dara's
 * audit named; one more gold site in an allow-listed file fails, so "the file is allowed" cannot quietly grow into
 * "anything in this file may be gold".
 *
 * Out of scope on purpose: `--warning` is semantic status (see the --warning-text guard), the user-chosen accent DATA
 * (`accentColor`, `accent` in embed/theme config), OPTION_COLORS and chart palettes.
 */
const SRC = join(__dirname, '..');
const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');

/** Gold custom properties declared in globals.css (`--accent`, `--accent-soft`, `--accent-text`, `--text-on-accent`, ...). */
export function goldProps(stylesheet: string): string[] {
  const names = new Set<string>();
  for (const m of stylesheet.matchAll(/(--(?:[a-z-]*-)?(?:accent|on-accent)[a-z-]*)\s*:/g)) names.add(m[1]!);
  return [...names];
}

/** Tailwind utility suffixes for the gold tokens: every `--color-X: var(--<gold prop>)` alias in the @theme block. */
export function goldUtilityNames(stylesheet: string, props: string[]): string[] {
  const out = new Set<string>();
  for (const m of stylesheet.matchAll(/--color-([a-z-]+)\s*:\s*var\((--[a-z-]+)\)/g)) {
    if (props.includes(m[2]!)) out.add(m[1]!);
  }
  return [...out];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function goldMatcher(stylesheet: string): RegExp {
  const props = goldProps(stylesheet);
  const names = goldUtilityNames(stylesheet, props);
  // `var(--accent)`, `var(--accent-soft, fallback)`, `[color:var(--accent)]`, and the raw `--accent` in a color-mix
  const propAlt = props.map(esc).join('|');
  // `bg-accent`, `text-accent-text`, `border-accent/30`, `hover:bg-accent-soft`, `!bg-accent`, `ring-accent/40`...
  const nameAlt = names.map(esc).join('|');
  const util = `(?:^|[\\s'"\`!:])(?:[a-z]+-)?(?:bg|text|border|ring|outline|fill|stroke|from|to|via|shadow|decoration|divide|caret)-(?:${nameAlt})(?![\\w-])`;
  return new RegExp(`(?:var\\((?:${propAlt})\\b|${util})`, 'g');
}

/** Gold uses in `text`, ignoring whole-line comments (a comment that NAMES the token is not a paint). */
export function goldUses(text: string, matcher: RegExp): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
    for (const m of line.matchAll(matcher)) out.push(m[0]!.trim());
  }
  return out;
}

/**
 * Dara's AGENT rows (ticket #1163 audit + her answers), as `file -> number of gold MATCHES (a tint and its label on one chip are two)`. A count, not a boolean.
 * Each entry says what the agent site IS; anything not here is not allowed to be gold.
 */
export const AGENT_GOLD: Record<string, number> = {
  // Tyron: the agent avatar badge, the working pulse dot, send-to-Tyron, the build starters, the full-screen exit chip,
  // the panel's resize handle (a Tyron surface)
  'components/tyron/agent-avatar.tsx': 3, // border, tint, glyph of the agent badge
  'components/tyron/tyron-conversation.tsx': 2, // the pulse dot, the send button
  'components/tyron/starter-cards.tsx': 1,
  'components/tyron/workspace-build.tsx': 1,
  'components/tyron/tyron-panel.tsx': 4, // resize handle hover + drag, the full-screen exit chip (tint + glyph)
  // The AI section: header label, the row icon, the Bot glyph, and the badge's gold branch (agent work waiting on you)
  'components/sidebar-ai-section.tsx': 5,
  // The palette's loading bar: Tyron working. (The selected row and key chip are NOT gold: bg-active / border-strong.)
  'components/command-palette.tsx': 1,
  // Runs: "waiting for you" is an agent run paused on a human
  'components/runs/run-detail-pane.tsx': 5,
  'components/runs/run-status-pill.tsx': 3,
  'app/w/[ws]/runs/page.tsx': 4,
  // Skills: "Written by an agent or an MCP client" and the agent tag. (The YOU tag is a human: neutral.)
  'components/skills/skill-bits.tsx': 2, // tint + label of "Written by an agent or an MCP client"
  'components/skills/skill-editor.tsx': 2, // the agent tag (tint + label)
  // The change-log badge for source != human (agent / automation / mcp)
  'components/entity/record-history.tsx': 2,
};

/** Files that DEFINE or carry the tokens rather than paint with them. */
const DEFINES_TOKENS = new Set(['app/globals.css', 'lib/embed-theme.ts']);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(tsx?|css)$/.test(name) && !/\.(unit\.)?test\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

describe('the gold set is derived from globals.css', () => {
  const props = goldProps(css);
  it('finds the real tokens (not an empty set)', () => {
    for (const p of ['--accent', '--accent-soft', '--accent-text', '--accent-hover', '--text-on-accent']) expect(props).toContain(p);
    expect(goldUtilityNames(css, props).sort()).toEqual(expect.arrayContaining(['accent', 'accent-soft', 'accent-text', 'accent-hover', 'on-accent']));
  });
  it('would cover a token declared tomorrow', () => {
    const fake = `${css}\n:root { --accent-wash: #fff; }\n@theme { --color-accent-wash: var(--accent-wash); }`;
    expect(goldUses('<i className="bg-accent-wash" />', goldMatcher(fake))).toHaveLength(1);
  });
});

describe('the scan itself (mutation checks: it must fire on what it exists to catch)', () => {
  const m = goldMatcher(css);
  it.each([
    'bg-accent',
    'bg-accent-soft',
    'bg-accent-soft/50',
    'text-accent',
    'text-accent-text',
    'text-on-accent',
    'border-accent',
    'hover:bg-accent-soft',
    '!bg-accent',
    'ring-accent/40',
    'outline-accent',
    'fill-accent',
    'bg-[var(--accent)]',
    'text-[var(--accent)]',
    'border-[color:var(--accent)]/30',
    'bg-[color-mix(in_srgb,var(--accent)_20%,var(--bg-card))]',
    "'!bg-[var(--accent)] !text-[var(--text-on-accent)]'",
    'stroke-[var(--accent-hover)]',
  ])('flags %s', (c) => {
    expect(goldUses(`className="x ${c} y"`, m).length).toBeGreaterThan(0);
  });
  it.each([
    'bg-primary-text',
    'bg-active',
    'text-primary-text',
    'border-border-strong',
    'accent-[var(--primary)]', // the native accent-color property, resolves to --primary
    'bg-warning',
    'text-warning',
    'bg-card',
    'ring-primary-text/40',
  ])('keeps %s', (c) => {
    expect(goldUses(`className="x ${c} y"`, m)).toEqual([]);
  });
  it('ignores a comment that names the token', () => {
    expect(goldUses('  // the gold is --accent: var(--accent) bg-accent\n  * bg-accent-soft', m)).toEqual([]);
  });
});

describe('gold only where an agent acts', () => {
  const m = goldMatcher(css);
  const files = walk(SRC).map((f) => relative(SRC, f));
  const counts = new Map<string, number>();
  for (const f of files) {
    if (DEFINES_TOKENS.has(f)) continue;
    const n = goldUses(readFileSync(join(SRC, f), 'utf8'), m).length;
    if (n > 0) counts.set(f, n);
  }

  it('scans a real population (not an empty glob)', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(counts.size).toBeGreaterThan(5);
  });
  it('every allow-listed file exists (a path that moved must not keep a stale exemption)', () => {
    for (const f of Object.keys(AGENT_GOLD)) expect(files, f).toContain(f);
  });
  it('no file outside the agent allow-list paints gold', () => {
    const offenders = [...counts].filter(([f]) => !(f in AGENT_GOLD)).map(([f, n]) => `${f}: ${n}`);
    expect(offenders).toEqual([]);
  });
  it('an allow-listed file paints gold in exactly its named agent sites, no more', () => {
    const drift = Object.entries(AGENT_GOLD)
      .filter(([f, n]) => (counts.get(f) ?? 0) !== n)
      .map(([f, n]) => `${f}: allowed ${n}, found ${counts.get(f) ?? 0}`);
    expect(drift).toEqual([]);
  });
});

/**
 * The neutral replacements must be REAL utilities. `text-on-dark` was first written as a utility, passed this file's
 * scan, and rendered an invisible label: Tailwind only knows the `--color-*` aliases of the @theme block, and
 * `--text-on-dark` has none (it is `text-[var(--text-on-dark)]`). A scan that proves what is absent cannot prove the
 * replacement exists, so the aliases are read out of the stylesheet and the bare form is flagged.
 */
describe('the neutral utilities the moves rely on are declared @theme colours', () => {
  const aliases = new Set([...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
  const NEUTRAL = ['primary-text', 'active', 'hover', 'hover-soft', 'border-strong', 'border-default', 'primary', 'warning-text', 'card', 'ink'];
  const bare = /(?:^|[\s'"`:!])(?:text|bg|border)-on-dark(?![\w-])/;
  it('declares the aliases the moves rely on', () => {
    for (const n of NEUTRAL) expect(aliases.has(n), n).toBe(true);
  });
  it('flags a bare text-on-dark utility (it has no alias; it is text-[var(--text-on-dark)])', () => {
    expect(bare.test('className="bg-primary text-on-dark"')).toBe(true);
    expect(bare.test('className="bg-primary text-[var(--text-on-dark)]"')).toBe(false);
  });
  it('no source file uses the bare form', () => {
    const offenders = walk(SRC)
      .filter((f) => /\.tsx?$/.test(f) && bare.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
