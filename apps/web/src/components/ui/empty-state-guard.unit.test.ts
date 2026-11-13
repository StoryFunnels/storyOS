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

/*
 * Round 2 (Vera, PR 1519): the first pattern was a list of nouns ("No packs", "No webhooks", ...) and so it saw only the empties its author
 * had already listed. Seven lists in the repo ("Nothing in the trash", "No deleted spaces.", "Nothing is connected yet.", "No tokens in this
 * workspace yet.", "No Runner yet", "No community packs published yet.", "No databases here that you can access.", "No AI client is
 * connected", "No earlier document versions yet.", two admin table rows) said nothing in the noun list and passed unseen. What they share
 * is not a noun but a SHAPE: an element whose visible text OPENS with "No"/"Nothing". So the pattern is now that shape (JSX text after a
 * tag, or on a line of its own), kept alongside the older phrase list for quoted strings ('No matches', "No job written yet").
 * A prop NAMED empty*= (emptyText, emptyLabel) is copy handed to a component, like title=/body=, and is checked where it is rendered.
 */
const SENTENCE =
  /((^|>\s*)(No|Nobody|No one|Nothing)\s[A-Za-z]|\b(has|have|had|is|are) (no|nothing|nobody)\b[^.]*\b(yet|here)\b|\b[Nn]o [a-z]+( [a-z]+){0,3} (here|yet)\b|\b(title|description|body)=\{?["'`](No|Nobody|Nothing)\s[A-Za-z]|Nothing (here|archived|linked|assigned|matches|in this range)|\bNo [a-z]+( [a-z]+)? (yet|match(es)?|found)\b|No (matches|results|packs|webhooks|agents|runs|rules|buttons|templates|sources|syncs|activity|deliveries|mappings|submissions|unread)\b|You['’]re all caught up|You haven['’]t created)/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}

/** The component whose opening tag most recently began at or before line i (a prop on a continuation line belongs to it). */
function nearestOpenTag(src: string[], i: number): string | null {
  for (let k = i; k >= Math.max(0, i - 12); k--) {
    // Skip an element that opened AND closed on its own line above (a quill={<Quill … />} prop is not the tag we are inside).
    const all = [...src[k]!.matchAll(/<([A-Z][A-Za-z]*)\b/g)].filter((m) => k === i || !new RegExp(`/>|</${m[1]}>`).test(src[k]!.slice(m.index!)));
    if (all.length) return all[all.length - 1]![1]!;
  }
  return null;
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
      // A copy prop passed on (emptyText="…") is rendered by the receiver: the receiver is checked below, where it prints the prop.
      if (/\bempty[A-Za-z]*=/.test(t)) return;
      if (!SENTENCE.test(t)) return;
      // Handed to the component: title=/body= ON an <EmptyState> (the nearest opening tag before the prop says so; a title= on a
      // SettingsRow or a Card is a hand-rolled empty state wearing a prop, which is how "Nothing in the trash" passed round 1),
      // title:/body: of a config object, or part of a multi-line prop whose opening line was one of those.
      const m = /\b(title|body)=/.exec(t);
      const openTag = m ? [...(t.slice(0, m.index).matchAll(/<([A-Z][A-Za-z]*)/g))].pop()?.[1] ?? nearestOpenTag(src, i) : null;
      const opened = src.slice(Math.max(0, i - 4), i).some((l) => /\b(title|body)=\{?\s*$/.test(l.trimEnd()));
      if ((m && openTag === 'EmptyState') || /\b(title|body):/.test(t) || (opened && nearestOpenTag(src, i) === 'EmptyState')) return;
      out.push({ key: rel, line: t });
    });
    // The receiver of an emptyText copy prop must hand it to <EmptyState>, not print it in a row or a <p>.
    src.forEach((line, i) => {
      if (!/\{emptyText\}/.test(line) || /^\s*(\/\/|\*)/.test(line)) return;
      if (/<EmptyState\b/.test(line) || nearestOpenTag(src, i) === 'EmptyState') return;
      out.push({ key: rel, line: line.trim() });
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
  'components/runners/works-in-picker.tsx': { n: 2, why: PICKER + ' (one); the other is the "Nothing yet." value of a field row, an inline value, not a pane' },
  'components/table-view/batch-bar.tsx': { n: 1, why: PICKER },
  'components/table-view/button-actions-editor.tsx': { n: 5, why: PICKER + ' (one); the others are "No options", the "No auth" option and two "No … connection yet" hints beside a connection field in the button-action form: form copy, not a pane' },
  'components/table-view/cells.tsx': { n: 1, why: PICKER },
  'components/tyron/thread-menu.tsx': { n: 1, why: PICKER },
  'components/ui/icon-picker.tsx': { n: 1, why: PICKER },
  'components/views/form-view.tsx': { n: 3, why: PICKER + ' (one); "No members" is an inline label in a member field (second); the third is the dependency rule hint (emptyText, "Always required — …"), also an inline hint' },
  'components/views/view-switcher.tsx': { n: 1, why: PICKER },
  'components/views/view-toolbar.tsx': { n: 3, why: PICKER + ' (two); the third is the "No filters on this view." line inside the Filter popover: menu content, not a pane' },
  'components/table-view/formula-editor.tsx': { n: 2, why: 'the formula editor autocomplete list and its field-reference hint: inline editor assistance, not a pane' },
  'components/views/empty-view-notice.tsx': { n: 1, why: 'the second line of a prop object handed to EmptyState (body copy), on a continuation line the scanner cannot attribute' },
  'app/w/[ws]/agents/page.tsx': { n: 1, why: 'a table cell placeholder for one agent with no job text, not an empty list' },
  'app/w/[ws]/settings/webhooks/page.tsx': { n: 1, why: 'an inline status label on a webhook row ("No deliveries yet"), not a pane' },
  'components/automations-panel.tsx': { n: 2, why: 'text inside a collapsible last-payload box ("No delivery received yet.", a status line of one automation) and a hint in the relation-action form ("has no relation fields yet — add one first"); neither is a list' },
  // Round 2 (the widened shape): found by the broader pattern, each read and judged. None is a list or pane with nothing in it.
  'app/(auth)/login/page.tsx': { n: 1, why: '"No account?" before the sign-up link: a prompt, not an empty state' },
  'app/f/[token]/page.tsx': { n: 1, why: '"No one to pick from": the empty options of a member field on a public form, a field value, not a pane' },
  'app/new-workspace/page.tsx': { n: 1, why: '"No databases. Build your own from scratch.": the description of the Start empty choice card' },
  'app/packs/[slug]/page.tsx': { n: 1, why: '"No credit card required": marketing copy beside a button' },
  'app/w/[ws]/settings/agent-rules/page.tsx': { n: 1, why: 'a sentence explaining that no approval gate is declared: the rule\'s state, shown with its own form' },
  'app/w/[ws]/settings/connect-ai/page.tsx': { n: 1, why: 'a troubleshooting step in a numbered help list ("No sign-in window appears")' },
  'app/w/[ws]/settings/integrations/delegate-agent/page.tsx': { n: 1, why: '"Nothing to connect — this is a built-in capability": the explanation on the card of a connection-less provider' },
  'app/w/[ws]/settings/integrations/linear/page.tsx': { n: 2, why: 'import wizard copy: "Nothing else to fill in" and the footnote under a preview, both sentences inside a form step' },
  'components/entity/scalar-fields.tsx': { n: 1, why: PICKER },
  'components/my-work/group-config.tsx': { n: 1, why: 'the "No grouping" <option> of a select' },
  'components/my-work/my-work-toolbar.tsx': { n: 1, why: 'the line inside the Filter popover when there are no groups to filter: popover content, like a picker' },
  'components/pack-install-dialog.tsx': { n: 1, why: '"No notes from the author.": the value of one labelled section of the install dialog' },
  'components/runners/agent-wake-facts.tsx': { n: 1, why: '"No database chosen.": an inline value of the "Works in" facts row (ticket #1289), not a pane' },
  'components/runners/runs-on-line.tsx': { n: 1, why: '"Runs on No Runner yet": an inline value in one sentence with its own Change action, not a pane' },
  'components/skills/skill-editor.tsx': { n: 2, why: 'a hint under the trigger field of the skill editor, and the "nobody else … to share it with yet" line beside the share-with control: both are form copy inside the editor, not a pane' },
  'components/social/post-social-editor.tsx': { n: 2, why: 'a connection hint and the "No image" <option> inside the post editor form' },
  'components/table-view/option-editors.tsx': { n: 1, why: 'the "No category" <option> of a select' },
  'components/views/dashboard-widgets.tsx': { n: 1, why: '"No data to chart yet.": the placeholder inside one chart tile, a widget state, not the dashboard' },
  'components/views/display-menu.tsx': { n: 1, why: 'a hint inside the Display menu explaining why a control is missing: menu copy' },
  'components/views/timeline-view.tsx': { n: 1, why: 'a configuration prompt ("No start-date field has been chosen"): the view is unconfigured, not empty; an empty Timeline database is covered by the database empty state' },
  'app/admin/page.tsx': { n: 2, why: '"No entitlement override — plan defaults apply.": the state of one workspace\'s override field in the instance-admin form; and a sentence of explanatory prose ("no managed run has executed yet") in a cost note' },
  'components/settings/provider-card.tsx': { n: 3, why: 'three JS status strings returned from the connection check ("has no live check yet", "cannot connect yet"): messages shown after an action, not an empty list' },
  'components/sidebar-ai-section.tsx': { n: 1, why: 'a count hint string on the AI section row ("Your workspace has no connected AI yet"): row meta copy, not a pane' },
  'components/skills/skills-library.tsx': { n: 1, why: 'the "no skills yet" count label in the library toolbar; the empty list itself is an EmptyState' },
  'components/views/dashboard-view.tsx': { n: 1, why: '"No access": the label of one tile whose database the viewer cannot read, not an empty list' },
};
const DEFERRED: Record<string, { n: number; why: string }> = {
  'components/views/form-view.tsx': { n: 1, why: 'DEFERRED, ticket #1291 list (Vera\'s call, PR 1519 round 3): "No fields yet — add one below" in the form builder is a real empty state, kept hand-rolled on purpose; the builder pane wants its own pass' },
  'components/command-palette.tsx': { n: 1, why: 'DEFERRED, ticket #1291 list: the command palette has its own designed empty row (ticket #1280 reworks the palette)' },
  'app/v/[token]/public-view-client.tsx': { n: 1, why: 'DEFERRED, ticket #1291 list: the public view page is a separate document with its own neutral tokens and a table cell, outside the app shell' },
  'app/w/[ws]/settings/integrations/google-calendar/page.tsx': { n: 2, why: 'DEFERRED, ticket #1291 list: a mapping form hint and a status sentence, one settings page the settings pass (ticket #1282) owns' },
  'components/automations/run-agent-editor.tsx': { n: 1, why: 'DEFERRED, ticket #1291 list: a sentence inside an automation action editor, not a list' },
  'components/entity/record-chrome.tsx': { n: 1, why: 'DEFERRED, ticket #1291 list: an agent picker hint inside the record header' },
  'components/workspace-home-blocks.tsx': { n: 2, why: 'DEFERRED, ticket #1291 list: Home blocks ("No automation runs yet", "Nothing is waiting on a person") are being rebuilt in open PR #1511 (declared overlap); migrating here would conflict' },
};

/** A file may sit in both lists (a picker line AND a deferred pane): its allowance is the sum, and both reasons are kept. */
function merged(): Record<string, { n: number; why: string }> {
  const out: Record<string, { n: number; why: string }> = {};
  for (const src of [NOT_AN_EMPTY_STATE, DEFERRED]) for (const [k, v] of Object.entries(src)) out[k] = out[k] ? { n: out[k]!.n + v.n, why: out[k]!.why + ' | ' + v.why } : { ...v };
  return out;
}

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
    const allowed = merged();
    const over = [...counts].filter(([k, n]) => n > (allowed[k]?.n ?? 0)).map(([k, n]) => `${k}: ${n} (allowed ${allowed[k]?.n ?? 0})`);
    expect(over).toEqual([]);
  });

  it('the allowlist does not go stale: every entry still matches exactly its count', () => {
    const stale = Object.entries(merged())
      .filter(([k, v]) => (counts.get(k) ?? 0) !== v.n)
      .map(([k, v]) => `${k}: expected ${v.n}, found ${counts.get(k) ?? 0}`);
    expect(stale).toEqual([]);
  });

  it('every allowance carries a reason', () => {
    for (const [k, v] of Object.entries(merged())) expect(v.why.length, k).toBeGreaterThan(15);
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
