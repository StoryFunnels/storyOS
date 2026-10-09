'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { CreateSkillInput, SkillSummary, SkillTemplate, UpdateSkillInput } from '@storyos/schemas';
import { api, apiErrorMessage } from '@/lib/api';

/**
 * #833 — the Skills library's data layer. Everything goes through the SAME
 * endpoints the MCP `list_skills`/`run_skill` tools call, so a skill authored
 * here is visible to another member's AI with no further step (AC7) — there is
 * no second copy of the rule in the browser.
 *
 * Deliberately absent: any call to `POST :id/run`. See the AC6 note on
 * SkillRow for why that is the position and not a gap.
 */
const skillsKey = (ws: string) => ['skills', ws] as const;

export function useSkills(ws: string) {
  return useQuery({
    queryKey: skillsKey(ws),
    enabled: Boolean(ws),
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/skills', { params: { path: { ws } } });
      if (error) throw error;
      return (data as unknown as { data: SkillSummary[] }).data;
    },
  });
}

export function useSkillTemplates(ws: string) {
  return useQuery({
    queryKey: ['skill-templates', ws],
    enabled: Boolean(ws),
    staleTime: Infinity, // scaffolds ship with the product; they do not change under a session
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/skills/templates', { params: { path: { ws } } });
      if (error) throw error;
      return (data as unknown as { data: SkillTemplate[] }).data;
    },
  });
}

export function useSkillMutations(ws: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: skillsKey(ws) });
  return {
    create: useMutation({
      mutationFn: async (body: CreateSkillInput) => {
        const { data, error } = await api.POST('/api/v1/workspaces/{ws}/skills', {
          params: { path: { ws } },
          body: body as never,
        });
        if (error) throw error;
        return data as unknown as SkillSummary;
      },
      onSuccess: invalidate,
      onError: (e) => toast.error(apiErrorMessage(e, 'Could not create the skill')),
    }),
    update: useMutation({
      mutationFn: async ({ id, body }: { id: string; body: UpdateSkillInput }) => {
        const { data, error } = await api.PATCH('/api/v1/workspaces/{ws}/skills/{id}', {
          params: { path: { ws, id } },
          body: body as never,
        });
        if (error) throw error;
        return data as unknown as SkillSummary;
      },
      onSuccess: invalidate,
      onError: (e) => toast.error(apiErrorMessage(e, 'Could not save the skill')),
    }),
    remove: useMutation({
      mutationFn: async (id: string) => {
        const { error } = await api.DELETE('/api/v1/workspaces/{ws}/skills/{id}', { params: { path: { ws, id } } });
        if (error) throw error;
      },
      onSuccess: invalidate,
      onError: (e) => toast.error(apiErrorMessage(e, 'Could not delete the skill')),
    }),
  };
}
