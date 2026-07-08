'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Blocks, BookOpen, Bug, Kanban, Megaphone, Newspaper, Filter, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export interface TemplatePreview {
  databases: Array<{ name: string; fields: Array<{ name: string; type: string }> }>;
  views: Array<{ database?: string; name: string; type: string }>;
  relations: string[];
}
export interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  category: 'agency' | 'creators' | 'dev';
  scope: 'pack' | 'database';
  preview: TemplatePreview;
}
export interface TemplateIntent {
  id: string;
  label: string;
  description: string;
  template: string;
  asks_name?: string;
  ends_with_invite?: boolean;
}
export interface InstallResult {
  applied: string;
  space_id: string;
  databases: Record<string, string>;
  sample_records: number;
  notes: string[];
}

export const TEMPLATE_ICONS: Record<string, typeof Kanban> = {
  'client-work': Kanban,
  'client-space': Users,
  'agency-crm': Megaphone,
  'content-pipeline': Newspaper,
  'social-calendar': Megaphone,
  funnels: Filter,
  'coaching-practice': Users,
  consulting: Blocks,
  'author-studio': BookOpen,
  'dev-project': Bug,
  'solo-dev': Bug,
};

const CATEGORIES = [
  { value: 'all', label: 'All' },
  { value: 'agency', label: 'Agency' },
  { value: 'creators', label: 'Creators' },
  { value: 'dev', label: 'Dev' },
] as const;

export function useTemplateRegistry() {
  return useQuery({
    queryKey: ['templates'],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/templates');
      if (error) throw error;
      return data as unknown as { data: TemplateSummary[]; intents: TemplateIntent[] };
    },
    staleTime: 5 * 60_000,
  });
}

export async function installTemplate(
  ws: string,
  slug: string,
  options: { space_id?: string; space_name?: string; include_samples?: boolean } = {},
): Promise<InstallResult> {
  const { data, error } = await api.POST('/api/v1/workspaces/{ws}/templates/{slug}/apply', {
    params: { path: { ws, slug } },
    body: options as never,
  });
  if (error) throw error;
  return data as unknown as InstallResult;
}

/** Where to go after an install — the client-space flow ends on the invite dialog. */
export function postInstallPath(ws: string, result: InstallResult, endsWithInvite?: boolean) {
  if (endsWithInvite) {
    return `/w/${ws}/settings/members?invite=guest&space=${result.space_id}&grant=editor`;
  }
  const firstDb = Object.values(result.databases)[0];
  return firstDb ? `/w/${ws}/d/${firstDb}` : `/w/${ws}`;
}

export function TemplateCard({
  template,
  selected,
  onClick,
}: {
  template: { slug: string; name: string; description: string };
  selected?: boolean;
  onClick: () => void;
}) {
  const Icon = TEMPLATE_ICONS[template.slug] ?? Blocks;
  return (
    <button
      type="button"
      className={cn(
        'flex items-start gap-3 rounded-[var(--radius-card)] border p-3 text-left',
        selected ? 'border-[var(--accent)] bg-accent-soft' : 'border-border-default hover:bg-hover',
      )}
      onClick={onClick}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
      <span>
        <span className="block text-[13px] font-medium text-ink">{template.name}</span>
        <span className="block text-[12px] text-muted">{template.description}</span>
      </span>
    </button>
  );
}

function PreviewPanel({ preview }: { preview: TemplatePreview }) {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border-default bg-canvas p-3">
      <div>
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">Databases</p>
        <div className="flex flex-col gap-1.5">
          {preview.databases.map((db) => (
            <div key={db.name}>
              <p className="text-[13px] font-medium text-ink">{db.name}</p>
              <p className="text-[12px] text-muted">
                {db.fields.map((f) => f.name).join(' · ')}
              </p>
            </div>
          ))}
        </div>
      </div>
      {preview.relations.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Relations</p>
          <p className="text-[12px] text-muted">{preview.relations.join('  ·  ')}</p>
        </div>
      )}
      {preview.views.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-faint">Views</p>
          <p className="text-[12px] text-muted">
            {preview.views.map((v) => `${v.name} (${v.type})`).join(' · ')}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * In-workspace template gallery (MN-033): browse by category, preview the
 * schema, and install — packs get a space name, database templates pick a
 * target space.
 */
export function TemplateGalleryDialog({
  ws,
  spaces,
  open,
  onOpenChange,
  initialSlug,
}: {
  ws: string;
  spaces: Array<{ id: string; name: string }>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialSlug?: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const registry = useTemplateRegistry();
  const [category, setCategory] = useState<string>('all');
  const [slug, setSlug] = useState<string | null>(initialSlug ?? null);
  const [spaceName, setSpaceName] = useState('');
  const [spaceId, setSpaceId] = useState('');
  const [includeSamples, setIncludeSamples] = useState(true);
  const [busy, setBusy] = useState(false);

  const templates = registry.data?.data ?? [];
  const selected = templates.find((t) => t.slug === slug);
  const visible = category === 'all' ? templates : templates.filter((t) => t.category === category);
  const intent = registry.data?.intents.find((i) => i.template === slug);

  async function install() {
    if (!selected) return;
    setBusy(true);
    try {
      const result = await installTemplate(ws, selected.slug, {
        include_samples: includeSamples,
        ...(selected.scope === 'pack'
          ? spaceName.trim()
            ? { space_name: spaceName.trim() }
            : {}
          : { space_id: spaceId || spaces[0]?.id }),
      });
      await qc.invalidateQueries();
      for (const note of result.notes) toast.info(note);
      toast.success(`${selected.name} installed`);
      onOpenChange(false);
      router.push(postInstallPath(ws, result, intent?.ends_with_invite));
    } catch {
      toast.error('Install failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={selected ? selected.name : 'Templates'} className="max-w-xl">
        {!selected ? (
          <div className="flex flex-col gap-3">
            <div className="flex gap-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  className={cn(
                    'rounded-[var(--radius-control)] px-2.5 py-1 text-[12px]',
                    category === c.value
                      ? 'bg-primary text-[var(--text-on-dark)]'
                      : 'text-muted hover:bg-hover',
                  )}
                  onClick={() => setCategory(c.value)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="flex max-h-[55vh] flex-col gap-1.5 overflow-y-auto pr-1">
              {visible.map((t) => (
                <TemplateCard key={t.slug} template={t} onClick={() => setSlug(t.slug)} />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <button
              type="button"
              className="flex items-center gap-1 self-start text-[12px] text-muted hover:text-ink"
              onClick={() => setSlug(null)}
            >
              <ArrowLeft className="h-3 w-3" /> All templates
            </button>
            <p className="-mt-2 text-[13px] text-ink-secondary">{selected.description}</p>
            <div className="max-h-[40vh] overflow-y-auto">
              <PreviewPanel preview={selected.preview} />
            </div>

            {selected.scope === 'pack' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tpl-space-name">
                  {intent?.asks_name ?? 'Space name'}
                </Label>
                <Input
                  id="tpl-space-name"
                  placeholder={selected.preview.databases[0] ? selected.name : 'Space name'}
                  value={spaceName}
                  onChange={(e) => setSpaceName(e.target.value)}
                />
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="tpl-space">Install into space</Label>
                <select
                  id="tpl-space"
                  className="h-9 rounded-[var(--radius-control)] border border-border-default bg-card px-2 text-sm text-ink"
                  value={spaceId || spaces[0]?.id || ''}
                  onChange={(e) => setSpaceId(e.target.value)}
                >
                  {spaces.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <label className="flex items-center gap-2 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={includeSamples}
                onChange={(e) => setIncludeSamples(e.target.checked)}
              />
              Include sample records to explore
            </label>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={busy} onClick={install}>
                {busy ? 'Installing…' : 'Use this template'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
