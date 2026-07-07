'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Kanban, Newspaper, Square } from 'lucide-react';
import { api } from '@/lib/api';
import { isErrorEnvelope } from '@storyos/sdk';
import { AuthCard } from '../(auth)/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const TEMPLATE_ICONS: Record<string, typeof Kanban> = {
  'client-work': Kanban,
  'content-pipeline': Newspaper,
};

export default function NewWorkspacePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [template, setTemplate] = useState<string | null>('client-work');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const templates = useQuery({
    queryKey: ['templates'],
    queryFn: async () => {
      const { data, error: apiError } = await api.GET('/api/v1/templates');
      if (apiError) throw apiError;
      return (data as unknown as { data: Array<{ slug: string; name: string; description: string }> }).data;
    },
  });

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error: apiError } = await api.POST('/api/v1/workspaces', { body: { name } });
    if (apiError) {
      setBusy(false);
      setError(isErrorEnvelope(apiError) ? apiError.error.message : 'Could not create workspace');
      return;
    }
    const wsId = (data as { id: string }).id;
    if (template) {
      await api.POST('/api/v1/workspaces/{ws}/templates/{slug}/apply', {
        params: { path: { ws: wsId, slug: template } },
      });
    }
    router.replace(`/w/${wsId}`);
  }

  return (
    <AuthCard title="Create your workspace">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="name">Workspace name</Label>
          <Input
            id="name"
            required
            autoFocus
            placeholder="e.g. JCM Agency"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Start from</Label>
          {(templates.data ?? []).map((t) => {
            const Icon = TEMPLATE_ICONS[t.slug] ?? Square;
            return (
              <button
                key={t.slug}
                type="button"
                className={cn(
                  'flex items-start gap-3 rounded-[var(--radius-card)] border p-3 text-left',
                  template === t.slug
                    ? 'border-[var(--accent)] bg-accent-soft'
                    : 'border-border-default hover:bg-hover',
                )}
                onClick={() => setTemplate(t.slug)}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                <span>
                  <span className="block text-[13px] font-medium text-ink">{t.name}</span>
                  <span className="block text-[12px] text-muted">{t.description}</span>
                </span>
              </button>
            );
          })}
          <button
            type="button"
            className={cn(
              'flex items-start gap-3 rounded-[var(--radius-card)] border p-3 text-left',
              template === null
                ? 'border-[var(--accent)] bg-accent-soft'
                : 'border-border-default hover:bg-hover',
            )}
            onClick={() => setTemplate(null)}
          >
            <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
            <span>
              <span className="block text-[13px] font-medium text-ink">Blank</span>
              <span className="block text-[12px] text-muted">Start from scratch.</span>
            </span>
          </button>
        </div>

        {error && <p className="text-[13px] text-error">{error}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Setting things up…' : 'Create workspace'}
        </Button>
      </form>
    </AuthCard>
  );
}
