import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/*
 * Ticket #1291 item 4 — "one empty-state component", enforced. The pattern is DERIVED from the inventory of what the eleven hand-rolled
 * variants had in common: each was a JSX line whose visible text is the empty sentence itself ("Nothing here…", "Nothing archived.",
 * "No … yet", "No … match", "You're all caught up", "You haven't created …"). A surface that renders that sentence in its own <p>/<div>
 * is, by construction, drawing its own empty state; one that hands it to <EmptyState title=/body=> is not. So the guard finds the
 * sentences and requires them to be an EmptyState prop, with a short, REASONED allowlist for the lines that are not an empty state
 * (an option list inside a picker popover has nothing to "fill": it is "no option matched what you typed", not a screen with nothing yet).
 * A new ad-hoc empty state fails here; the fix is `<EmptyState variant=…>`, not a new allowlist row.
 */
const SRC = fileURLToPath(new URL('../../', import.meta.url));

const SENTENCE =
  /(Nothing (here|archived|linked|assigned|matches|in this range)|\bNo [a-z]+( [a-z]+)? (yet|match(es)?|found)\b|No (matches|results|packs|webhooks|agents|runs|rules|buttons|templates|sources|syncs|activity|deliveries|mappings|submissions|unread)\b|You['’]re all caught up|You haven['’]t created)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

/** Lines that print an empty sentence as their own element rather than as an EmptyState prop. Comments are not rendering. */
function adHoc(): { key: string; line: string }[] {
  const out: { key: string; line: string }[] = [];
  for (const f of files(SRC)) {
    const rel = relative(SRC, f);
    if (rel === 'components/ui/empty-state.tsx') continue;
    // Block comments are not rendering: blank them out, keeping the line count so keys stay meaningful.
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n');
    src.forEach((line, i) => {
      const t = line.trim();
      if (/^(\/\/|\*|\/\*|\{\/\*)/.test(t)) return;
      if (!SENTENCE.test(t)) return;
      // Handed to the component: title=…, body=… or title: …, or part of a multi-line prop whose opening line was one of those.
      const opened = src.slice(Math.max(0, i - 4), i).some((l) => /\b(title|body)=\{?\s*$/.test(l.trimEnd()));
      if (/\b(title|body)=/.test(t) || /\b(title|body):/.test(t) || opened) return;
      out.push({ key: rel, line: t });
    });
  }
  return out;
}

/**
 * Every remaining sentence, by file, with WHY it is not an empty state. Counts are exact: a second line in the same file is a new
 * ad-hoc empty state and must fail. A genuine surface still to migrate goes in DEFERRED with the ticket line, never in here.
 */
const PICKER = 'an option list inside a popover/menu/dialog picker: "no option matched what you typed", not a pane with nothing yet';
const NOT_AN_EMPTY_STATE: Record<string, { n: number; why: string }> = {
  'components/entity/mentions.tsx': { n: 1, why: PICKER },
  'components/quick-add-fab.tsx': { n: 1, why: PICKER },
  'components/runners/works-in-picker.tsx': { n: 1, why: PICKER },
  'components/table-view/batch-bar.tsx': { n: 1, why: PICKER },
  'components/table-view/button-actions-editor.tsx': { n: 1, why: PICKER },
  'components/table-view/cells.tsx': { n: 1, why: PICKER },
  'components/tyron/thread-menu.tsx': { n: 1, why: PICKER },
  'components/ui/icon-picker.tsx': { n: 1, why: PICKER },
  'components/views/form-view.tsx': { n: 2, why: PICKER + ' (one); the other, "No fields yet — add one below" in the form builder, is DEFERRED (ticket #1291 list): a builder pane that wants its own pass' },
  'components/views/view-switcher.tsx': { n: 1, why: PICKER },
  'components/views/view-toolbar.tsx': { n: 2, why: PICKER },
  'components/table-view/formula-editor.tsx': { n: 2, why: 'the formula editor autocomplete list and its field-reference hint: inline editor assistance, not a pane' },
  'components/views/empty-view-notice.tsx': { n: 1, why: 'the second line of a prop object handed to EmptyState (body copy), on a continuation line the scanner cannot attribute' },
  'app/w/[ws]/agents/page.tsx': { n: 1, why: 'a table cell placeholder for one agent with no job text, not an empty list' },
  'app/w/[ws]/settings/webhooks/page.tsx': { n: 1, why: 'an inline status label on a webhook row ("No deliveries yet"), not a pane' },
  'components/automations-panel.tsx': { n: 1, why: 'text inside a collapsible last-payload box, a status line of one automation, not a list' },
};
const DEFERRED: Record<string, { n: number; why: string }> = {
  'components/command-palette.tsx': { n: 1, why: 'DEFERRED, ticket #1291 list: the command palette has its own designed empty row (ticket #1280 reworks the palette)' },
  'app/v/[token]/public-view-client.tsx': { n: 1, why: 'DEFERRED, ticket #1291 list: the public view page is a separate document with its own neutral tokens and a table cell, outside the app shell' },
  'app/admin/page.tsx': { n: 1, why: 'DEFERRED, ticket #1291 list: a table row in the instance-admin run table (a <td> inside <tbody>), a table-empty shape this component does not have yet' },
  'app/w/[ws]/settings/integrations/google-calendar/page.tsx': { n: 2, why: 'DEFERRED, ticket #1291 list: a mapping form hint and a status sentence, one settings page the settings pass (ticket #1282) owns' },
  'components/automations/run-agent-editor.tsx': { n: 1, why: 'DEFERRED, ticket #1291 list: a sentence inside an automation action editor, not a list' },
  'components/entity/record-chrome.tsx': { n: 1, why: 'DEFERRED, ticket #1291 list: an agent picker hint inside the record header' },
  'components/workspace-home-blocks.tsx': { n: 1, why: 'DEFERRED, ticket #1291 list: Home blocks are being rebuilt in open PR #1511 (declared overlap); migrating here would conflict' },
};

describe('one EmptyState component (ticket #1291)', () => {
  const found = adHoc();
  const counts = new Map<string, number>();
  for (const { key } of found) counts.set(key, (counts.get(key) ?? 0) + 1);

  it('prints the remaining ad-hoc sentences (inventory)', () => {
    // Not an assertion: `vitest --reporter=verbose` shows what is left; the next test is the gate.
    expect(Array.isArray(found)).toBe(true);
    if (process.env['EMPTY_INVENTORY']) writeFileSync(process.env['EMPTY_INVENTORY'], JSON.stringify(found, null, 1));
  });

  it('no file renders an empty sentence outside <EmptyState> beyond its reasoned allowance', () => {
    const allowed = { ...NOT_AN_EMPTY_STATE, ...DEFERRED };
    const over = [...counts].filter(([k, n]) => n > (allowed[k]?.n ?? 0)).map(([k, n]) => `${k}: ${n} (allowed ${allowed[k]?.n ?? 0})`);
    expect(over).toEqual([]);
  });

  it('the allowlist does not go stale: every entry still matches exactly its count', () => {
    const stale = Object.entries({ ...NOT_AN_EMPTY_STATE, ...DEFERRED })
      .filter(([k, v]) => (counts.get(k) ?? 0) !== v.n)
      .map(([k, v]) => `${k}: expected ${v.n}, found ${counts.get(k) ?? 0}`);
    expect(stale).toEqual([]);
  });

  it('every allowance carries a reason', () => {
    for (const [k, v] of Object.entries({ ...NOT_AN_EMPTY_STATE, ...DEFERRED })) expect(v.why.length, k).toBeGreaterThan(15);
  });

  it('the one component exists and the old database-only copy is gone', () => {
    expect(statSync(join(SRC, 'components/ui/empty-state.tsx')).isFile()).toBe(true);
    expect(() => statSync(join(SRC, 'components/views/empty-state.tsx'))).toThrow();
  });

  it('every wrapper composes it: no file besides ui/empty-state.tsx defines the three shapes (dashed card, grey-circle column) itself', () => {
    const offenders = files(SRC)
      .filter((f) => relative(SRC, f) !== 'components/ui/empty-state.tsx')
      .filter((f) => {
        const s = readFileSync(f, 'utf8');
        // the retired database variant: a 40px grey circle holding an Inbox/Filter glyph above a sentence
        return /h-10 w-10 items-center justify-center rounded-full bg-hover text-muted/.test(s);
      })
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
