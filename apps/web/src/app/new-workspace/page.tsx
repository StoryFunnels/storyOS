'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import posthog from 'posthog-js';
import { Blocks, Square } from 'lucide-react';
import { api } from '@/lib/api';
import { isErrorEnvelope } from '@storyos/sdk';
import { AuthCard } from '../(auth)/auth-card';
import {
  TEMPLATE_ICONS,
  TemplateCard,
  installTemplate,
  postInstallPath,
  useTemplateRegistry,
} from '@/components/template-gallery';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Intent-first onboarding (MN-033): "What are you working on?" maps to a
 * template pack; browsing everything and Blank stay one click away.
 */
export default function NewWorkspacePage() {
  const router = useRouter();
  const registry = useTemplateRegistry();
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<string>('intent:agency'); // intent:<id> | template:<slug> | blank
  const [clientName, setClientName] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const intents = registry.data?.intents ?? [];
  const templates = registry.data?.data ?? [];
  const activeIntent = choice.startsWith('intent:')
    ? intents.find((i) => i.id === choice.slice(7))
    : undefined;

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

    const slug = activeIntent?.template ?? (choice.startsWith('template:') ? choice.slice(9) : null);
    posthog.capture('workspace_created', {
      has_template: !!slug,
      template_slug: slug ?? null,
      intent: choice.startsWith('intent:') ? choice.slice(7) : null,
    });
    if (!slug) {
      router.replace(`/w/${wsId}`);
      return;
    }
    try {
      const result = await installTemplate(wsId, slug, {
        ...(activeIntent?.asks_name && clientName.trim() ? { space_name: clientName.trim() } : {}),
      });
      router.replace(postInstallPath(wsId, result, activeIntent?.ends_with_invite));
    } catch {
      router.replace(`/w/${wsId}`); // workspace exists; template can be added later
    }
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
          <Label>What are you working on?</Label>
          <div className="flex max-h-[45vh] flex-col gap-1.5 overflow-y-auto pr-1">
            {!browsing
              ? intents.map((intent) => {
                  const Icon = TEMPLATE_ICONS[intent.template] ?? Blocks;
                  return (
                    <button
                      key={intent.id}
                      type="button"
                      className={cn(
                        'flex items-start gap-3 rounded-[var(--radius-card)] border p-3 text-left',
                        choice === `intent:${intent.id}`
                          ? 'border-[var(--accent)] bg-accent-soft'
                          : 'border-border-default hover:bg-hover',
                      )}
                      onClick={() => setChoice(`intent:${intent.id}`)}
                    >
                      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                      <span>
                        <span className="block text-[13px] font-medium text-ink">{intent.label}</span>
                        <span className="block text-[12px] text-muted">{intent.description}</span>
                      </span>
                    </button>
                  );
                })
              : templates.map((t) => (
                  <TemplateCard
                    key={t.slug}
                    template={t}
                    selected={choice === `template:${t.slug}`}
                    onClick={() => setChoice(`template:${t.slug}`)}
                  />
                ))}

            <button
              type="button"
              className={cn(
                'flex items-start gap-3 rounded-[var(--radius-card)] border p-3 text-left',
                choice === 'blank'
                  ? 'border-[var(--accent)] bg-accent-soft'
                  : 'border-border-default hover:bg-hover',
              )}
              onClick={() => setChoice('blank')}
            >
              <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <span>
                <span className="block text-[13px] font-medium text-ink">Blank</span>
                <span className="block text-[12px] text-muted">Start from scratch.</span>
              </span>
            </button>
          </div>
          <button
            type="button"
            className="self-start text-[12px] text-muted underline-offset-2 hover:underline"
            onClick={() => setBrowsing((b) => !b)}
          >
            {browsing ? '← Back to quick picks' : 'Something else — browse all templates'}
          </button>
        </div>

        {activeIntent?.asks_name && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="client-name">{activeIntent.asks_name}</Label>
            <Input
              id="client-name"
              placeholder="e.g. Globex Corp"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
            />
          </div>
        )}

        {error && <p className="text-[13px] text-error">{error}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? 'Setting things up…' : 'Create workspace'}
        </Button>
      </form>
    </AuthCard>
  );
}
