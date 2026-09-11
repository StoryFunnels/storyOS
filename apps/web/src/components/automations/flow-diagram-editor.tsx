'use client';

import { useMemo, useState } from 'react';
import { GitBranch, GripVertical, Plus, Settings2, Split, Trash2 } from 'lucide-react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DragPreview, useDragPresentation, vacatedSlotClass } from '@/components/ui/drag-presentation';
import type { Field } from '@/components/table-view/use-table-data';
import {
  ACTION_TYPE_GROUPS,
  defaultActionFor,
  type ButtonAction,
} from '@/components/table-view/button-actions-editor';
import { conditionLabel, deriveFlowDiagram, triggerLabel } from './flow-diagram-model';
import type { DiagramCondition, DiagramTrigger } from './flow-diagram-model';

/**
 * #285 — slice C: editing on the same diagram slice A (#283) draws read-only.
 *
 * Deliberately does NOT reimplement any action's settings form. Reorder, add
 * and remove are the only operations this component owns — clicking an
 * action's settings icon calls `onEditSettings`, which the caller wires to
 * switching back to the EXISTING list editor (`ButtonActionsEditor`), the
 * same rule shape's other view. Two views, one `actions` array, one
 * `onChange` — there is no second storage or a parallel edit path to drift
 * from the form (#375/#380/#383/#399/#408/#422's shape).
 *
 * Node ids for dnd-kit are assigned per ACTION OBJECT IDENTITY (a WeakMap,
 * module-scoped) rather than per array index or a stored field, because
 * `ButtonAction` has no id of its own and index is exactly what's changing
 * during a reorder. `patch`-style updates elsewhere in this codebase replace
 * only the touched array slot with a new object, so every other action's
 * identity — and therefore its id — survives a reorder untouched.
 */
const nodeIds = new WeakMap<ButtonAction, string>();
let nodeIdCounter = 0;
function idFor(action: ButtonAction): string {
  let id = nodeIds.get(action);
  if (!id) {
    id = `flow-action-${++nodeIdCounter}`;
    nodeIds.set(action, id);
  }
  return id;
}

export function FlowDiagramEditor({
  trigger,
  condition,
  actions,
  onChange,
  onEditSettings,
  fields,
  db,
  relationFields,
  mailConnectionId,
  restrictToWebhookSafe,
}: {
  trigger: DiagramTrigger;
  condition?: DiagramCondition | null;
  actions: ButtonAction[];
  onChange: (actions: ButtonAction[]) => void;
  /** Switches the caller back to the existing per-action settings editor,
   * focused on this action. */
  onEditSettings: (index: number) => void;
  fields: Field[];
  db: string;
  relationFields: Field[];
  mailConnectionId?: string;
  restrictToWebhookSafe?: boolean;
}) {
  const [addingAt, setAddingAt] = useState(false);
  const ids = useMemo(() => actions.map(idFor), [actions]);
  const flow = deriveFlowDiagram({ trigger, condition, actions }, fields);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const label = (id: string) => {
    const i = ids.indexOf(id);
    return i >= 0 ? flow.actions[i]?.label : undefined;
  };
  const drag = useDragPresentation(
    label,
    {
      onDragEnd: (e) => {
        if (!e.over || e.active.id === e.over.id) return;
        const from = ids.indexOf(String(e.active.id));
        const to = ids.indexOf(String(e.over.id));
        if (from < 0 || to < 0) return;
        onChange(arrayMove(actions, from, to));
      },
    },
    ids,
  );

  function removeAt(i: number) {
    onChange(actions.filter((_, j) => j !== i));
  }

  function addAction(type: string) {
    onChange([...actions, defaultActionFor(type, { db, relationFields, mailConnectionId, restrictToWebhookSafe })]);
    setAddingAt(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <FlowBox kind="trigger">{flow.triggerLabel}</FlowBox>
      {flow.conditionLabel && (
        <>
          <Connector />
          <FlowBox kind="condition">Only if {flow.conditionLabel}</FlowBox>
        </>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} {...drag.contextProps}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {actions.map((action, i) => {
            const step = flow.actions[i]!;
            return (
              <ActionNode
                key={ids[i]}
                id={ids[i]!}
                step={step}
                onRemove={() => removeAt(i)}
                onEditSettings={() => onEditSettings(i)}
              />
            );
          })}
        </SortableContext>
        <DragPreview>
          {drag.activeId && (
            <div className="rounded-[var(--radius-control)] border border-border-default bg-card px-3 py-2 text-[13px] font-medium text-ink shadow-[var(--shadow-lifted)]">
              {label(drag.activeId) ?? ''}
            </div>
          )}
        </DragPreview>
      </DndContext>

      <Connector />
      {addingAt ? (
        <select
          autoFocus
          className="h-8 w-64 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-[13px] text-ink"
          defaultValue=""
          onChange={(e) => e.target.value && addAction(e.target.value)}
          onBlur={() => setAddingAt(false)}
        >
          <option value="" disabled>
            Choose an action type…
          </option>
          {ACTION_TYPE_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.options
                .filter((o) => !restrictToWebhookSafe || o.value !== 'set_values')
                .map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      ) : (
        <button
          type="button"
          className="flex items-center gap-1 self-start rounded-[var(--radius-control)] border border-dashed border-border-default px-2 py-1 text-[13px] text-muted hover:border-solid hover:text-ink"
          onClick={() => setAddingAt(true)}
        >
          <Plus className="h-3.5 w-3.5" /> Add action
        </button>
      )}
    </div>
  );
}

function ActionNode({
  id,
  step,
  onRemove,
  onEditSettings,
}: {
  id: string;
  step: { label: string; branchLabel: string | null; fanOut: boolean; recognized: boolean };
  onRemove: () => void;
  onEditSettings: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  return (
    <div className="flex flex-col gap-2">
      <Connector />
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        // #656 — the dragged content floats in the shared DragPreview overlay
        // (below), so this slot never competes for stacking order; it only
        // needs to mark itself as vacated (#409/#631), same as every other
        // sortable list in this app.
        className={vacatedSlotClass(isDragging)}
      >
        <FlowBox kind={step.recognized ? 'action' : 'unknown'}>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className="shrink-0 cursor-grab touch-none rounded p-0.5 text-faint hover:bg-hover hover:text-ink active:cursor-grabbing"
              aria-label={`Drag to reorder ${step.label}`}
              {...attributes}
              {...listeners}
            >
              <GripVertical className="h-3.5 w-3.5" />
            </button>
            {step.fanOut && <Split className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{step.label}</span>
            {!step.recognized && (
              <span className="shrink-0 text-[11px] text-faint">(diagram can't draw this one yet)</span>
            )}
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-ink"
              title="Edit settings"
              onClick={onEditSettings}
            >
              <Settings2 className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="shrink-0 rounded p-0.5 text-faint hover:bg-hover hover:text-error"
              title="Remove action"
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          {step.branchLabel && (
            <div className="mt-1.5 flex items-center gap-1 rounded-[var(--radius-control)] border border-dashed border-border-default bg-card px-2 py-1 text-[12px] text-muted">
              <GitBranch className="h-3 w-3 shrink-0" aria-hidden />
              Only if {step.branchLabel}
            </div>
          )}
        </FlowBox>
      </div>
    </div>
  );
}

function Connector() {
  return <div className="ml-4 h-3 w-px bg-border-default" aria-hidden />;
}

function FlowBox({ kind, children }: { kind: 'trigger' | 'condition' | 'action' | 'unknown'; children: React.ReactNode }) {
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

// Re-exported so the model's own label helpers stay the single source of
// truth for trigger/condition sentences (#283) — the editor never derives
// its own copy of them.
export { conditionLabel, triggerLabel };
