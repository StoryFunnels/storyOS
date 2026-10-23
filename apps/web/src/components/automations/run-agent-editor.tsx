'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { agentModeOf, agentNote, scheduleScopeNote } from '@/lib/run-agent-words';
import type { AgentNote } from '@/lib/run-agent-words';
import { cn } from '@/lib/utils';

/**
 * Ticket #1056 — the "Run an agent" action's editor: choose the agent, optionally give it an instruction for this run, and be told
 * plainly what running it overnight means (the agent's AI mode) and how many times a scheduled rule will run it.
 *
 * The agent is stored as the agent record's id (the API accepts an id or its public number). Fields the form does not show
 * (`tool_scope`, `max_steps`, `dry_run`, `require_approval`, …) are kept as they are when a rule that has them is edited here.
 */
export interface RunAgentAction {
  type: 'run_agent';
  agent: string;
  prompt?: string;
  [extra: string]: unknown;
}

interface AgentRow {
  id: string;
  title: string;
  values: Record<string, unknown>;
}

function Note({ note }: { note: AgentNote }) {
  return (
    <p className="flex gap-2 text-label text-ink-secondary">
      <span
        aria-hidden
        className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', note.tone === 'warn' ? 'bg-warning' : 'bg-border-strong')}
      />
      <span>{note.text}</span>
    </p>
  );
}

export function RunAgentEditor({
  ws,
  action,
  onChange,
  triggerType,
  hasFilter,
}: {
  ws: string;
  action: RunAgentAction;
  onChange: (next: RunAgentAction) => void;
  /** The rule's trigger, so a scheduled rule can say how many runs it makes. Undefined for a button. */
  triggerType?: string;
  hasFilter?: boolean;
}) {
  const pack = useQuery({
    queryKey: ['agents-pack', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/agents', { params: { path: { ws } } } as never);
      if (error) throw error;
      return data as unknown as { exists: boolean; id?: string };
    },
  });
  const agentsDbId = pack.data?.exists ? pack.data.id : undefined;
  const agents = useQuery({
    queryKey: ['run-agent-options', ws, agentsDbId],
    queryFn: async () => {
      const [rows, db] = await Promise.all([
        api.GET('/api/v1/workspaces/{ws}/databases/{db}/records', {
          params: { path: { ws, db: agentsDbId! }, query: { limit: 100 } },
        } as never),
        api.GET('/api/v1/workspaces/{ws}/databases/{db}', { params: { path: { ws, db: agentsDbId! } } } as never),
      ]);
      if (rows.error || db.error) throw rows.error ?? db.error;
      const fields = (db.data as unknown as { fields: Array<{ apiName: string; options?: Array<{ id: string; label: string }> }> }).fields;
      const modeOptions = fields.find((f) => f.apiName === 'ai_mode')?.options ?? [];
      return {
        modeLabel: (id: unknown) => modeOptions.find((o) => o.id === id)?.label ?? null,
        rows: (rows.data as unknown as { data: AgentRow[] }).data,
      };
    },
    enabled: Boolean(agentsDbId),
  });

  const rows = agents.data?.rows ?? [];
  const chosen = rows.find((r) => r.id === action.agent);
  const note = chosen
    ? agentNote({
        enabled: chosen.values['enabled'] === true,
        mode: agentModeOf(agents.data?.modeLabel(chosen.values['ai_mode'])),
      })
    : null;
  const scope = triggerType ? scheduleScopeNote({ triggerType, hasFilter: Boolean(hasFilter) }) : null;

  if (pack.isSuccess && !agentsDbId) {
    return (
      <p className="text-label text-muted">
        No agents are set up in this workspace yet, so there is nothing to run. Set one up first.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Select
        size="sm"
        aria-label="Agent to run"
        value={action.agent}
        onChange={(e) => onChange({ ...action, agent: e.target.value })}
      >
        <option value="">{agents.isLoading ? 'Loading agents…' : 'Choose an agent…'}</option>
        {/* An agent the rule already names that is no longer in the list (deleted) stays selectable, never silently swapped. */}
        {action.agent && !chosen && !agents.isLoading && <option value={action.agent}>An agent that no longer exists</option>}
        {rows.map((r) => (
          <option key={r.id} value={r.id}>
            {r.title}
          </option>
        ))}
      </Select>
      <Textarea
        className="min-h-[56px]"
        aria-label="Instruction for this run"
        placeholder="Optional: an instruction for this run only. Leave empty to use the agent’s own goal."
        value={action.prompt ?? ''}
        onChange={(e) => onChange({ ...action, prompt: e.target.value || undefined })}
      />
      {note && <Note note={note} />}
      {scope && <Note note={scope} />}
      <p className="text-label text-muted">
        If the agent wants to do something a person has to approve, the run stops and waits for them.
      </p>
    </div>
  );
}
