import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #362 — the four starter cards, asserted as CONTENT rather than as pixels.
 *
 * An empty chat box is a test most people fail. The four were chosen against the
 * founder's diagnosis of the core problem — "they will have problem buying in
 * the whole database system / concept" — so two of them exist to teach that
 * concept by demonstration.
 *
 * What can rot here is the wording of the prompts, and the wording is doing real
 * work: card 3's field-TYPE instruction is the difference between a column of
 * text and the "oh, THAT'S what a database is" moment, and card 4's rollup step
 * had to be made explicit before the model would perform it. A refactor that
 * tidied either sentence would pass a rendering test and quietly remove the
 * point of the card.
 */
const SOURCE = readFileSync(join(import.meta.dirname, 'starter-cards.tsx'), 'utf8');

describe('#362 starter cards', () => {
  it('offers exactly four', () => {
    const titles = [...SOURCE.matchAll(/^\s+title: '(.+?)',$/gm)].map((m) => m[1]);
    expect(titles).toEqual([
      'Build me a workspace',
      'What needs me today?',
      'Turn a list into a database',
      'Connect two things',
    ]);
  });

  it('card 2 is READ-ONLY, and says so on the card', () => {
    // The safest possible first interaction. A nervous first-time user should be
    // able to see that trying it costs them nothing, without reading a reply.
    expect(SOURCE).toContain("readOnly: true");
    expect(SOURCE).toContain('Changes nothing — just reads');
    expect(SOURCE).toContain('Do not change anything.');
  });

  it('card 3 asks for field TYPES, which is the entire point of it', () => {
    // Left to itself a model produces a column of text for everything, which
    // demonstrates nothing. Verified live: Email→email, Date→date, Status→select.
    expect(SOURCE).toContain('sensible field TYPES');
    expect(SOURCE).toContain('not a column of text for everything');
  });

  it('card 4 demands the ROLLUP, not just the link', () => {
    /*
     * "The point is the payoff, not the link" — and the first version proved it:
     * asked to "connect two databases and show what it enables", the model made
     * the relation and stopped. The rollup step had to be named as a step, with
     * the tool and the config shape, before it happened.
     */
    expect(SOURCE).toContain('add a ROLLUP field');
    expect(SOURCE).toContain('Do not stop after making the link');
  });

  it('card 4 works from an EMPTY workspace, which is the only place it appears', () => {
    /*
     * The flaw worth remembering: these cards only show on a new workspace, so
     * on the one surface where "connect two things" exists there is usually
     * nothing to connect. A card that answers "you don't have two databases yet"
     * is dead exactly for the user it was written for.
     */
    expect(SOURCE).toContain('Otherwise create a pair that does');
  });

  it('every card either acts on click or opens its own input — none prefills the composer', () => {
    // The AC's rule. A card that types into the composer and abandons you there
    // is the failure it is guarding against.
    expect(SOURCE).toContain('card.prompt ? onAsk(card.prompt) : setOpen(card.key)');
    // Card 3 owns its paste box and its own action button.
    expect(SOURCE).toContain('Make it a database');
    // Card 1 hands off to WorkspaceBuild, which owns the description box and the
    // "Build my workspace" button — #363's surface, reused rather than copied.
    expect(SOURCE).toContain('<WorkspaceBuild');
  });
});
