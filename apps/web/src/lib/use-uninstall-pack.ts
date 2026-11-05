'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * Uninstall one installed pack (ticket #1186): the call the business-packs page made inline, shared so Settings › Packs and the
 * marketplace's Installed list run the same request and refresh the same caches. The CONFIRMATION is the caller's
 * (`confirmUninstallPack` through `useConfirm`): this only runs after a yes.
 */
export function useUninstallPack(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (installId: string) => {
      const { data, error } = await api.POST(
        '/api/v1/workspaces/{ws}/packs/{installId}/uninstall' as never,
        { params: { path: { ws, installId } } } as never,
      );
      if (error) throw error;
      return data as unknown as { removed: unknown[]; kept: { name: string; reason?: string }[] };
    },
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['packs-installed', ws] });
      void qc.invalidateQueries({ queryKey: ['onboarding', ws] });
      toast.success(
        data.kept.length > 0
          ? `Uninstalled — kept ${data.kept.length} item(s) you'd changed since install`
          : 'Uninstalled cleanly',
      );
    },
    onError: () => toast.error('Uninstall failed'),
  });
}
