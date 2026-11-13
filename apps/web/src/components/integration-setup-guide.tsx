import { CheckCircle2 } from 'lucide-react';
import { setupStepStates } from '@/lib/integration-setup';
import { SettingsBox } from '@/components/settings/settings-chrome';
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
    <SettingsBox title={title} className={className}>
      <ol>
        {steps.map((step, index) => {
          const state = states[index];
          return (
            <li
              key={step.label}
              data-state={state}
              className={cn(
                'flex min-h-[46px] items-center gap-3 border-t border-border-default px-3.5 py-2 text-body first:border-t-0',
                state === 'current' && 'bg-hover',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-meta font-semibold',
                  state === 'current' && 'bg-primary text-[var(--text-on-dark)]',
                  state === 'complete' && 'border border-border-default bg-hover text-ink',
                  state === 'upcoming' && 'bg-hover text-muted',
                )}
              >
                {state === 'complete' ? <CheckCircle2 className="h-3.5 w-3.5" aria-label="Done" /> : index + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col leading-[1.35]">
                <b className="font-medium text-ink">{step.label}</b>
                <span className="text-label leading-[1.35]! text-muted">{step.description}</span>
              </span>
              {state === 'current' && <span className="shrink-0 text-label font-medium text-ink-secondary">Next</span>}
            </li>
          );
        })}
      </ol>
    </SettingsBox>
  );
}
