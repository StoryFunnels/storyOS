'use client';

import { toast } from 'sonner';
import { MenuSelect } from '@/components/ui/menu-select';
import { apiErrorMessage } from '@/lib/api';
import { useSidebarMutations, useWorkspace } from '@/lib/queries';
import { canEditWorkspaceModel, WORKSPACE_MODEL_OPTIONS, workspaceModelSelected, workspaceModelToStore } from '@/lib/runners/agent-settings';

/**
 * Ticket #1180 (web) — Settings › Agent rules › "Default model for agents". An admin setting (the API refuses anyone else and any
 * token, session only). An agent that runs on a Runner uses this unless its own page names a model. "Claude Code's own default"
 * is stored as nothing (null): the Runner then passes no --model at all.
 */
export function DefaultAgentModel({ ws }: { ws: string }) {
  const workspace = useWorkspace(ws);
  const { updateWorkspace } = useSidebarMutations(ws);
  const stored = workspace.data?.settings?.default_agent_model ?? null;
  const canEdit = canEditWorkspaceModel(workspace.data?.role);

  function pick(value: string) {
    updateWorkspace.mutate(
      { default_agent_model: workspaceModelToStore(value) },
      { onError: (e) => toast.error(apiErrorMessage(e, 'Could not save. Try again.')) },
    );
  }

  return (
    <div
      className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-card)] border border-border-default bg-card px-3.5 py-3"
      data-testid="default-agent-model"
    >
      <div className="min-w-0 flex-1 basis-64">
        <h2 className="m-0 text-body font-semibold text-ink">Default model for agents</h2>
        <p className="m-0 mt-0.5 text-label leading-[1.45] text-muted">
          Agents that run on a Runner use this unless their own page says otherwise. Smaller models use less of each person’s Claude limit.
        </p>
      </div>
      <MenuSelect
        label="Default model for agents"
        value={workspaceModelSelected(stored)}
        onChange={pick}
        disabled={!canEdit || updateWorkspace.isPending}
        options={WORKSPACE_MODEL_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        className="max-w-none sm:w-[12rem]"
        contentClassName="w-[14rem]"
      />
    </div>
  );
}
