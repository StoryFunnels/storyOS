'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { SkillEditor } from '@/components/skills/skill-editor';
import { useSkillTemplates } from '@/components/skills/use-skills';

export default function NewSkillPage() {
  const { ws } = useParams<{ ws: string }>();
  const templateId = useSearchParams().get('template');
  const templates = useSkillTemplates(ws);
  // Wait for the scaffolds before mounting the form: the editor seeds its draft
  // once, so mounting early would silently drop the chosen template.
  if (templateId && templates.isPending) return <p className="p-4 text-body text-muted">Loading scaffold…</p>;
  const template = templateId ? templates.data?.find((t) => t.id === templateId) : undefined;
  return (
    <div className="h-full overflow-auto">
      <SkillEditor key={template?.id ?? 'blank'} ws={ws} template={template} />
    </div>
  );
}
