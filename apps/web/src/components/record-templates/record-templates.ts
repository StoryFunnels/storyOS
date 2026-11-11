import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RecordTemplate } from '@storyos/schemas';
import { api } from '@/lib/api';

/**
 * ticket #1240 - the web half of record templates (API: ticket #1218 / PR #1440). One query per database, shared by the New menu,
 * the Manage dialog and the record's "Save as template", so a save or a delete shows up in all three without a reload.
 *
 * The decisions that are not drawing live here as plain functions so each has a test: whether New grows a menu at all, what a
 * template row says, what to tell the person when the server dropped a preset, and how to read the new record's id back.
 */

export const recordTemplatesKey = (ws: string, db: string) => ['record-templates', ws, db] as const;

const BASE = '/api/v1/workspaces/{ws}/databases/{db}/record-templates' as const;

export function useRecordTemplates(ws: string, db: string) {
  return useQuery({
    queryKey: recordTemplatesKey(ws, db),
    queryFn: async () => {
      const { data, error } = await api.GET(BASE, { params: { path: { ws, db } } });
      if (error) throw error;
      return (data as unknown as { data: RecordTemplate[] }).data;
    },
    staleTime: 30_000,
  });
}

/** Unconfigured is not invalid: a database with no templates (or a list that has not loaded / failed) keeps the plain New button. */
export function hasTemplateMenu(templates: readonly RecordTemplate[] | undefined): boolean {
  return (templates?.length ?? 0) > 0;
}

/** A pack's template is marked so an editor knows deleting it is not the same as deleting their own. */
export function templateRowHint(t: Pick<RecordTemplate, 'description' | 'origin'>): string {
  return t.description?.trim() || (t.origin === 'pack' ? 'From a pack' : '');
}

export interface SkippedPreset {
  field: string;
  reason: string;
}

/** The server drops a preset that no longer fits the schema and says so. Say it too: a record that quietly lacks its Type is the bug. */
export function skippedMessage(skipped: readonly SkippedPreset[] | undefined): string | null {
  if (!skipped || skipped.length === 0) return null;
  const names = skipped.map((s) => s.field).join(', ');
  return skipped.length === 1
    ? `Created, but the preset for ${names} could not be applied`
    : `Created, but ${skipped.length} presets could not be applied (${names})`;
}

export interface AppliedTemplate {
  id: string;
  skipped: SkippedPreset[];
}

/** `{ record, skipped }`; a body without a record id is an error, not a navigation to `/r/undefined`. */
export function readApplied(body: unknown): AppliedTemplate {
  const b = body as { record?: { id?: unknown }; skipped?: SkippedPreset[] } | null | undefined;
  const id = b?.record?.id;
  if (typeof id !== 'string' || id === '') throw new Error('The template did not return a record');
  return { id, skipped: Array.isArray(b?.skipped) ? b.skipped : [] };
}

export function useApplyTemplate(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (template: string) => {
      const { data, error } = await api.POST(`${BASE}/{template}/records`, {
        params: { path: { ws, db, template } },
        body: { values: {} },
      });
      if (error) throw error;
      return readApplied(data);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['records', ws, db] }),
  });
}

export function useSaveRecordAsTemplate(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { record_id: string; name: string; description?: string }) => {
      const { error } = await api.POST(`${BASE}/from-record`, {
        params: { path: { ws, db } },
        body: input,
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: recordTemplatesKey(ws, db) }),
  });
}

export function useEditTemplate(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; name: string; description: string | null }) => {
      const { error } = await api.PATCH(`${BASE}/{template}`, {
        params: { path: { ws, db, template: input.id } },
        body: { name: input.name, description: input.description },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: recordTemplatesKey(ws, db) }),
  });
}

export function useDeleteTemplate(ws: string, db: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (template: string) => {
      const { error } = await api.DELETE(`${BASE}/{template}`, {
        params: { path: { ws, db, template } },
      });
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: recordTemplatesKey(ws, db) }),
  });
}
