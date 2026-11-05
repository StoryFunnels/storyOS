'use client';

import { toast } from 'sonner';
import { apiErrorMessage } from '@/lib/api';
import { useSidebarMutations, useWorkspace } from '@/lib/queries';

/**
 * Tickets #848 / #867 / #1187 — the ONE workspace setting "Let AI share skills with the whole workspace" (`agents_may_publish_skills`).
 *
 * It is ON by default (the founder's ruling): only an explicit `false` turns it off, so an untouched workspace reads as on. It was a
 * switch in General; ticket #1187 moved it to Agent rules, an agent policy that sits with the other agent rules. The setting, its API
 * call and its default are unchanged. The API refuses this setting from any token or connected AI, so a person at a browser is the only
 * path (a switch an agent can flip is decorative).
 */
export function skillSharingOn(settings: { agents_may_publish_skills?: boolean } | null | undefined): boolean {
  return settings?.agents_may_publish_skills !== false;
}

export function useSkillSharing(ws: string) {
  const workspace = useWorkspace(ws);
  const { updateWorkspace } = useSidebarMutations(ws);
  const on = skillSharingOn(workspace.data?.settings);
  const set = (next: boolean) =>
    updateWorkspace.mutate(
      { agents_may_publish_skills: next },
      {
        onSuccess: () => toast.success(next ? 'AI can share skills with the workspace' : 'AI-written skills now stay private'),
        onError: (e) => toast.error(apiErrorMessage(e, 'Could not save — try again')),
      },
    );
  return { on, set, loading: workspace.isLoading, saving: updateWorkspace.isPending };
}
