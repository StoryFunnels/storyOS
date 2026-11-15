import type { HTMLAttributes, ReactNode } from 'react';
import { Filter } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Ticket #1291 item 4 — THE empty state. One component, three shapes, because "nothing to show" is three different moments and
 * eleven hand-rolled variants were drifting between them (a centred grey-circle column, a muted line, an 18px heading, no message at
 * all on a table). Every surface that has nothing to show renders THIS; `empty-state-guard.unit.test.ts` fails on a new ad-hoc copy.
 *
 *  - `big`      a first-run screen with nothing yet (an empty database in every view, agents, runs, skills). A centred box, one
 *               heading, the one action. `quill` is a SLOT for her art (ticket #1026 waits on the final drawing): a caller that has
 *               none passes nothing and the box is simply the heading and the action.
 *  - `filtered` a filter or Find hides everything. The compact card from the design reference: filter glyph, the reason, a line
 *               saying nothing is deleted, one button. It sits at the top of the view like a row, it does not take the screen.
 *  - `list`     a secondary list pane that is empty (inbox, archived, trash, linked records, personal, my work). One muted line.
 *
 * Sizes are the design reference's, measured in a browser (ticket #1291): filtered = 12px gap, 14px/16px padding, 1px dashed border,
 * 6px radius, 13px/650 reason, 12px sub-line, 16px glyph, 27px button; big = 10px gap, 28/16/24px padding, 14px/700 heading, 13px
 * body; list = 12px line, 9px/11px padding. `empty-state.unit.test.ts` pins them.
 */
export type EmptyStateVariant = 'big' | 'filtered' | 'list';

export type EmptyStateAction = {
  label: string;
  onClick: () => void;
  /** A lucide glyph drawn before the label (13px). */
  icon?: ReactNode;
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
  testId?: string;
};

/** The action's size: the reference's button is 27px tall, 12px/600; `Button size="sm"` is 28px and 13px, so the shape sets its own. */
const ACTION_CLASS = 'h-[27px] text-label font-semibold';

export type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  variant: EmptyStateVariant;
  /** `big`: the heading. `filtered`: the reason. `list`: the line itself. */
  title: ReactNode;
  /** `big`: the line under the heading. `filtered`: the "nothing is deleted" line. Ignored by `list`. */
  body?: ReactNode;
  /** `big` only: the database's purpose line (#400), above the body. */
  description?: string | null;
  /** The one way forward. Absent for a reader who cannot act, or a list line that needs none. */
  action?: EmptyStateAction;
  /** `big` only: the slot for Quill. Nothing is drawn when it is absent. */
  quill?: ReactNode;
  /** `big` only: fill the pane and centre the box in it (a database view), instead of sitting in the page flow. */
  fill?: boolean;
  /** `filtered` only: replaces the filter glyph. */
  icon?: ReactNode;
  /** `big` only: more content under the action (the skills page's template cards). */
  children?: ReactNode;
};

function ActionButton({ action }: { action: EmptyStateAction }) {
  return (
    <Button
      type="button"
      size="sm"
      variant={action.variant === 'secondary' ? 'secondary' : 'primary'}
      className={ACTION_CLASS}
      disabled={action.disabled}
      onClick={action.onClick}
      data-testid={action.testId}
    >
      {action.icon}
      {action.label}
    </Button>
  );
}

export function EmptyState({ variant, title, body, description, action, quill, fill, icon, children, className, ...rest }: EmptyStateProps) {
  if (variant === 'list') {
    return (
      <div role="status" data-empty-state="list" className={cn('px-[11px] py-[9px] text-label text-muted', className)} {...rest}>
        {title}
      </div>
    );
  }

  if (variant === 'filtered') {
    return (
      <div
        role="status"
        data-empty-state="filtered"
        className={cn(
          'my-2.5 flex max-w-[560px] items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-border-strong bg-card px-4 py-3.5 text-body text-muted',
          className,
        )}
        {...rest}
      >
        <span className="shrink-0 text-muted" aria-hidden>
          {icon ?? <Filter className="h-4 w-4" />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <b className="font-[650] text-ink">{title}</b>
          {body && <span className="text-label">{body}</span>}
        </div>
        {action && <ActionButton action={action} />}
      </div>
    );
  }

  const box = (
    <div
      data-empty-state="big"
      className={cn(
        'mx-auto flex w-full max-w-[480px] flex-col items-center gap-2.5 rounded-[var(--radius-card)] border border-border-default bg-card px-4 pb-6 pt-7 text-center',
        className,
      )}
      {...rest}
    >
      {quill}
      <h3 className="m-0 text-prose font-bold leading-[normal] text-ink">{title}</h3>
      {description && <p className="m-0 max-w-sm text-body text-ink-secondary">{description}</p>}
      {body && <p className="m-0 max-w-sm text-body text-muted">{body}</p>}
      {action && <ActionButton action={action} />}
      {children}
    </div>
  );
  return fill ? <div className="flex h-full items-center justify-center overflow-auto p-6">{box}</div> : box;
}
