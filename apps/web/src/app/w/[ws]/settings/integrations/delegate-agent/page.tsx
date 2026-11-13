'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button, buttonVariants } from '@/components/ui/button';
import { IntegrationSetupGuide } from '@/components/integration-setup-guide';
import { ProviderPageHeader } from '@/components/settings/provider-card';
import { cn } from '@/lib/utils';

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
    <div className="mx-auto max-w-3xl p-4 sm:p-8">
      <div className="mb-5">
        <ProviderPageHeader ws={ws} id="delegate-agent">
          Assign a StoryOS agent to any record — from that record&apos;s <strong>···</strong> menu, choose
          <strong> Delegate to agent</strong> and pick one. It runs through the same tool catalog a manual run uses, and posts its outcome back as a
          comment on the record, with a link to the full run.
        </ProviderPageHeader>
      </div>

      <IntegrationSetupGuide
        className="mb-5"
        steps={[
          {
            label: 'Enable Agents',
            description: 'Provision the Agents, Runs, and Triggers databases.',
            complete: enabled,
          },
          {
            label: 'Create an agent',
            description:
              'Open Agents and define its goal, instructions, scopes, and enabled state.',
            complete: false,
          },
          {
            label: 'Delegate from a record',
            description:
              'Open a record menu, choose Delegate to agent, then inspect its run and comment.',
            complete: false,
          },
        ]}
      />

      {!enabled ? (
        <div className="flex flex-col gap-3">
          <p className="text-body text-ink-secondary">
            Nothing to connect — this is a built-in capability. Enable it to provision the Agents
            database, then create an agent record (name, goal, scopes) to delegate to.
          </p>
          <Button
            size="sm"
            onClick={() => enable.mutate()}
            disabled={enable.isPending}
            className="w-fit"
          >
            {enable.isPending ? 'Enabling…' : 'Enable'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-body text-ink-secondary">
            Agents are provisioned. Create or edit agent records — name, goal, instructions, scopes
            — in the Agents database, then delegate to any of them from a record&apos;s{' '}
            <strong>···</strong> menu. Only an
            <strong> enabled</strong> agent can be delegated to.
          </p>
          {pack.data?.id && (
            <Link
              href={`/w/${ws}/d/${pack.data.id}`}
              className={cn(buttonVariants({ variant: 'secondary' }), 'w-fit')}
            >
              Open Agents →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
