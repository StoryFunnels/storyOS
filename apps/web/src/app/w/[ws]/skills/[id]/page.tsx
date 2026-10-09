'use client';

import { useParams } from 'next/navigation';
import { SkillEditor } from '@/components/skills/skill-editor';
import { useSkills } from '@/components/skills/use-skills';

export default function SkillPage() {
  const { ws, id } = useParams<{ ws: string; id: string }>();
  const skills = useSkills(ws);
  if (skills.isPending) return <p className="p-4 text-body text-muted">Loading skill…</p>;
  if (skills.isError) return <p className="p-4 text-body text-error" role="alert">Could not load this skill.</p>;
  // Looked up in the list the caller is allowed to see (the same visibility rule
  // `list_skills` enforces) — a skill that is not in it is, to this viewer, not
  // here, which is exactly what a 404 would say.
  const skill = skills.data.find((s) => s.id === id);
  if (!skill) return <p className="p-4 text-body text-muted">This skill does not exist, or is not shared with you.</p>;
  return (
    <div className="h-full overflow-auto">
      <SkillEditor key={skill.id} ws={ws} skill={skill} />
    </div>
  );
}
