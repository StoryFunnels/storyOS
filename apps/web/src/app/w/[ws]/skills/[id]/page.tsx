'use client';

import { entityGateView } from '@/components/quill/entity-gate';
import { entityState } from '@/lib/entity-state';
import { useParams } from 'next/navigation';
import { SkillEditor } from '@/components/skills/skill-editor';
import { useSkills } from '@/components/skills/use-skills';

export default function SkillPage() {
  const { ws, id } = useParams<{ ws: string; id: string }>();
  const skills = useSkills(ws);
  const blocked = entityGateView(entityState(skills), () => void skills.refetch());
  if (blocked) return blocked;
  if (!skills.data) return <p className="p-4 text-body text-muted">Loading skill…</p>;
  // Looked up in the list the caller is allowed to see (the same visibility rule
  // `list_skills` enforces) — a skill that is not in it is, to this viewer, not
  // here, which is exactly what a 404 would say.
  const skill = skills.data.find((s) => s.id === id);
  // #1291 — one page for "does not exist" and "not shared with you".
  if (!skill) return entityGateView({ kind: 'gone' });
  return (
    <div className="h-full overflow-auto">
      <SkillEditor key={skill.id} ws={ws} skill={skill} />
    </div>
  );
}
