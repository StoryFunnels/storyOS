import { CheckCircle2 } from 'lucide-react';
import { setupStepStates } from '@/lib/integration-setup';
import { cn } from '@/lib/utils';

export interface IntegrationSetupStep {
  label: string;
  description: string;
  complete: boolean;
}

export function IntegrationSetupGuide({
  steps,
  title = 'How setup works',
  className,
}: {
  steps: readonly IntegrationSetupStep[];
  title?: string;
  className?: string;
}) {
  const states = setupStepStates(steps.map((step) => step.complete));

  return (
    <section
      className={cn(
        'rounded-[var(--radius-card)] border border-border-default bg-card p-4',
        className,
      )}
      aria-label={title}
    >
      <h2 className="text-[12px] font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <ol className="mt-3 grid gap-2 sm:grid-flow-col sm:auto-cols-fr">
        {steps.map((step, index) => {
          const state = states[index];
          return (
            <li
              key={step.label}
              className={cn(
                'rounded-[var(--radius-control)] border p-3',
                state === 'current'
                  ? 'border-border-strong bg-accent-soft'
                  : 'border-border-default bg-page',
                state === 'upcoming' && 'opacity-70',
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                    state === 'current' && 'bg-primary text-[var(--text-on-dark)]',
                    state === 'complete' && 'bg-accent-soft text-ink',
                    state === 'upcoming' && 'bg-hover text-muted',
                  )}
                >
                  {state === 'complete' ? <CheckCircle2 className="h-3.5 w-3.5" /> : index + 1}
                </span>
                <p className="text-[12px] font-semibold text-ink">{step.label}</p>
                {state === 'current' && (
                  <span className="ml-auto rounded-full bg-card px-2 py-0.5 text-[10px] font-medium text-ink">
                    Next
                  </span>
                )}
              </div>
              <p className="mt-2 text-[11px] leading-4 text-muted">{step.description}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
