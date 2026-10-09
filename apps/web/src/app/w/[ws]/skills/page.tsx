'use client';

import { useParams } from 'next/navigation';
import { SkillsLibrary } from '@/components/skills/skills-library';

export default function SkillsPage() {
  const { ws } = useParams<{ ws: string }>();
  return (
    <div className="h-full overflow-auto">
      <SkillsLibrary ws={ws} />
    </div>
  );
}
