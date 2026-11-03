'use client';

import { useParams } from 'next/navigation';
import { AgentPage } from '@/components/runners/agent-page';

/** Ticket #1139 — one agent's page. The component carries the screen; this route only names it. */
export default function AgentRoute() {
  const { ws, agent } = useParams<{ ws: string; agent: string }>();
  return <AgentPage ws={ws} agentId={agent} />;
}
