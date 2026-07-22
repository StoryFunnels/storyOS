'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface AgentsPack {
  exists: boolean;
  id?: string;
  name?: string;
}

/**
 * "Delegate to agent" (#44) — the flagship integrations-directory card.
 *
 * There is no credential to connect here (`auth_kind: 'delegate'` in
 * integration-registry.ts): the capability is built-in. What this page
 * "enables" is the Agents/Runs/Agent Triggers pack itself (ADR-0010 §1) —
 * the same idempotent `ensure` every agent feature provisions on first use —
 * so an admin can go straight from the gallery to a usable Agents database
 * without hunting for it.
 *
 * The actual delegate action lives where the ticket asked for it: on a
 * record itself (its "…" menu → Delegate to agent, `record-chrome.tsx`), not
 * on this settings page — this page is the card's landing/setup surface.
 */
export default function DelegateToAgentIntegrationPage() {
  const { ws } = useParams<{ ws: string }>();
  const qc = useQueryClient();

  const pack = useQuery({
    queryKey: ['agents-pack', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/agents', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as AgentsPack;
    },
  });

  const enable = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST('/api/v1/workspaces/{ws}/agents/ensure', {
        params: { path: { ws } },
      } as never);
      if (error) throw error;
      return data as unknown as { agentsDb: { id: string } };
    },
    onSuccess: () => {
      toast.success('Agents enabled — create an agent record to delegate to it');
      void qc.invalidateQueries({ queryKey: ['agents-pack', ws] });
    },
    onError: () => toast.error('Could not enable Agents'),
  });

  const enabled = pack.data?.exists === true;

  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <Link href={`/w/${ws}/settings/integrations`} className="mb-4 inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink">
        <ArrowLeft className="h-3.5 w-3.5" /> Integrations
      </Link>
      <div className="mb-3 flex items-center gap-2">
        <Bot className="h-6 w-6 text-ink" />
        <h1 className="text-lg font-semibold text-ink">Delegate to agent</h1>
        {enabled && <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-ink">enabled</span>}
      </div>
      <p className="mb-5 text-[13px] text-muted">
        Assign a StoryOS agent to any record — from that record&apos;s <strong>···</strong> menu, choose
        <strong> Delegate to agent</strong> and pick one. It runs through the same tool catalog a manual run
        uses, and posts its outcome back as a comment on the record, with a link to the full run.
      </p>

      {!enabled ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-ink-secondary">
            Nothing to connect — this is a built-in capability. Enable it to provision the Agents database,
            then create an agent record (name, goal, scopes) to delegate to.
          </p>
          <Button size="sm" onClick={() => enable.mutate()} disabled={enable.isPending} className="w-fit">
            {enable.isPending ? 'Enabling…' : 'Enable'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-ink-secondary">
            Agents are provisioned. Create or edit agent records — name, goal, instructions, scopes — in the
            Agents database, then delegate to any of them from a record&apos;s <strong>···</strong> menu. Only an
            <strong> enabled</strong> agent can be delegated to.
          </p>
          {pack.data?.id && (
            <Link
              href={`/w/${ws}/d/${pack.data.id}`}
              className="w-fit rounded-[var(--radius-control)] border border-border-default bg-card px-3 py-1.5 text-[13px] font-medium text-ink hover:border-border-strong"
            >
              Open Agents →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
