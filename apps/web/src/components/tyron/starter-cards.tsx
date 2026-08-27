'use client';

import { useState } from 'react';
import { Blocks, CalendarCheck, Link2, Table2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WorkspaceBuild } from './workspace-build';

/**
 * The four things worth clicking on a brand-new workspace (#362).
 *
 * An empty chat box is a test most people fail. These four are chosen against
 * the founder's own diagnosis of the core problem — "they will have problem
 * buying in the whole database system / concept" — so TWO OF THE FOUR exist to
 * teach that concept by demonstration rather than explanation:
 *
 *  3. paste a mess, watch it become typed columns — the single best
 *     "oh, THAT'S what a database is" moment available, and it starts from the
 *     mess people actually have rather than from an abstraction.
 *  4. relations are the concept people fail on, and the exact reason StoryOS is
 *     not a spreadsheet. Nobody discovers this alone.
 *
 * ## Two of them act on one click; two need a sentence first
 *
 * The AC says "each produces a visible result from one click — no card merely
 * pre-fills the composer and waits", and that is the right rule. Cards 2 and 4
 * meet it literally: one click, Tyron works, something appears.
 *
 * Cards 1 and 3 cannot. "Build me a workspace" is meaningless without knowing
 * what you do, and "turn this list into a database" is meaningless without the
 * list. What the AC is guarding against is a card that types into the composer
 * and abandons you there — so each of these opens its OWN input with its own
 * button, and acts on submit. The distinction is that the card stays
 * responsible for the outcome rather than handing you a half-written message.
 */
interface Card {
  key: string;
  icon: LucideIcon;
  title: string;
  blurb: string;
  /** Sent verbatim on click. Cards with their own input have none. */
  prompt?: string;
  /** Reassurance shown on the card that changes nothing. */
  readOnly?: boolean;
}

const CARDS: Card[] = [
  {
    key: 'build',
    icon: Blocks,
    title: 'Build me a workspace',
    blurb: 'Describe what you do. I’ll set up databases that fit and connect them.',
  },
  {
    key: 'today',
    icon: CalendarCheck,
    title: 'What needs me today?',
    blurb: 'I’ll read across everything and tell you what’s waiting.',
    // The safest possible first interaction: it changes nothing, and it proves
    // Tyron can see the whole workspace rather than one table.
    readOnly: true,
    prompt: 'What needs my attention today? Look across everything in this workspace and tell me what is waiting, overdue or unassigned. Do not change anything.',
  },
  {
    key: 'paste',
    icon: Table2,
    title: 'Turn a list into a database',
    blurb: 'Paste names, emails, a chunk of a spreadsheet — anything messy.',
  },
  {
    key: 'connect',
    icon: Link2,
    title: 'Connect two things',
    blurb: 'Link two databases and see what that suddenly makes possible.',
    prompt:
      'Look at the databases in this workspace and connect two that obviously belong together with a relation. ' +
      'Then add a rollup or a linked view that shows what the connection makes possible, and tell me in one sentence what I can now see that I could not before.',
  },
];

export function StarterCards({
  ws,
  ensureThread,
  onAsk,
  onBuilt,
  busy,
}: {
  ws: string;
  ensureThread: (firstMessage: string) => Promise<string>;
  /** Sends a message through the ordinary turn path — same one the composer uses. */
  onAsk: (message: string) => void;
  onBuilt: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');

  if (open === 'build') {
    return <WorkspaceBuild ws={ws} ensureThread={ensureThread} onBuilt={onBuilt} />;
  }

  if (open === 'paste') {
    return (
      <div className="rounded-[var(--radius-card)] border border-border-default bg-card p-4">
        <p className="text-[13px] font-medium text-ink">Paste your list.</p>
        <p className="mt-1 text-[12px] text-muted">
          Rows from a spreadsheet, a block of names and emails, notes — it does not need to be tidy.
        </p>
        <textarea
          rows={5}
          autoFocus
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          aria-label="Paste a list"
          placeholder={'Ada Lovelace, ada@example.com, London\nAlan Turing, alan@example.com, Manchester'}
          className="mt-3 w-full resize-none rounded-[var(--radius-control)] border border-border-default bg-card px-2.5 py-1.5 text-[13px] text-ink placeholder:text-faint focus:border-[var(--accent)] focus:outline-none"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={!pasted.trim() || busy}
            onClick={() => {
              /*
               * The field TYPES are the point of this card, and they are asked
               * for explicitly. A model left to itself produces a column of text
               * for everything, which demonstrates nothing — the whole "oh,
               * THAT'S what a database is" moment is seeing an email become an
               * email and a date become a date.
               */
              onAsk(
                'Turn this into a database. Work out sensible field TYPES from the content — an email ' +
                  'address should be an email field, a date should be a date, a repeated value should be a ' +
                  'select — not a column of text for everything. Then tell me what you made.\n\n' +
                  pasted.trim(),
              );
              setOpen(null);
              setPasted('');
            }}
            className="rounded-[var(--radius-control)] bg-[var(--accent)] px-3 py-1.5 text-[13px] font-medium text-[var(--on-accent,#fff)] disabled:opacity-40"
          >
            Make it a database
          </button>
          <button type="button" onClick={() => setOpen(null)} className="px-1 text-[12px] text-muted hover:text-ink">
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {CARDS.map((card) => (
        <button
          key={card.key}
          type="button"
          disabled={busy}
          onClick={() => (card.prompt ? onAsk(card.prompt) : setOpen(card.key))}
          className={cn(
            'flex items-start gap-3 rounded-[var(--radius-card)] border border-border-default bg-card p-3 text-left',
            'hover:border-border-strong hover:bg-hover disabled:opacity-50',
          )}
        >
          <card.icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">{card.title}</span>
            <span className="mt-0.5 block text-[12px] text-muted">{card.blurb}</span>
            {card.readOnly && (
              // Named on the card, not buried in the reply. A nervous first-time
              // user should be able to see that trying this costs them nothing.
              <span className="mt-1 block text-[11px] text-faint">Changes nothing — just reads.</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
