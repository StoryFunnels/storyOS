'use client';

import type { ReactNode } from 'react';
import { GitBranch, Split } from 'lucide-react';
import type { Field } from '@/components/table-view/use-table-data';
import { deriveFlowDiagram, type DiagramRule } from './flow-diagram-model';

/**
 * #283 — read-only projection of a rule as trigger → condition → ordered
 * actions. Simple flex boxes per the ticket's own explicit allowance (the
 * canvas question is slice B/#284's to answer); nothing here can drag,
 * connect, or delete — this is a diagram, not an editor.
 */
export function FlowDiagram({ rule, fields }: { rule: DiagramRule; fields: Field[] }) {
  const flow = deriveFlowDiagram(rule, fields);

  return (
    <div className="flex flex-col gap-2">
      <FlowBox kind="trigger">{flow.triggerLabel}</FlowBox>
      {flow.conditionLabel && (
        <>
          <Connector />
          <FlowBox kind="condition">Only if {flow.conditionLabel}</FlowBox>
        </>
      )}
      {flow.actions.map((action) => (
        <div key={action.index} className="flex flex-col gap-2">
          <Connector />
          <FlowBox kind={action.recognized ? 'action' : 'unknown'}>
            <div className="flex items-center gap-1.5">
              {action.fanOut && <Split className="h-3.5 w-3.5 shrink-0" aria-hidden />}
              <span>{action.label}</span>
              {!action.recognized && (
                <span className="text-[11px] text-faint">(diagram can't draw this one yet)</span>
              )}
            </div>
            {action.branchLabel && (
              <div className="mt-1.5 flex items-center gap-1 rounded-[var(--radius-control)] border border-dashed border-border-default bg-card px-2 py-1 text-[12px] text-muted">
                <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
                Only if {action.branchLabel}
              </div>
            )}
          </FlowBox>
        </div>
      ))}
    </div>
  );
}

function Connector() {
  return <div className="ml-4 h-3 w-px bg-border-default" aria-hidden />;
}

function FlowBox({
  kind,
  children,
}: {
  kind: 'trigger' | 'condition' | 'action' | 'unknown';
  children: ReactNode;
}) {
  return (
    <div
      className={
        'rounded-[var(--radius-card)] border px-3 py-2 text-[13px] ' +
        (kind === 'trigger'
          ? 'border-primary/40 bg-primary/5 text-ink'
          : kind === 'condition'
            ? 'border-dashed border-border-default bg-card text-ink-secondary'
            : kind === 'unknown'
              ? 'border-warning/50 bg-warning/5 text-ink'
              : 'border-border-default bg-card text-ink')
      }
    >
      {children}
    </div>
  );
}
