'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, apiErrorMessage } from '@/lib/api';
import { httpBaseUrlProblem } from '@/lib/http-base-url';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * #1035 — set or change the ONE address an HTTP connection's credential may be sent to (`PATCH /connections/:id {base_url}`,
 * admin only on the server). A connection made before this existed sends nothing until it has one, so for those this is the
 * way back: the button says "Set base URL", not "Base URL".
 */
export function BaseUrlDialog({
  ws,
  connection,
}: {
  ws: string;
  connection: { id: string; name: string; base_url?: string | null; needs_base_url?: boolean };
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(connection.base_url ?? '');
  const [touched, setTouched] = useState(false);
  const problem = httpBaseUrlProblem(value);
  const needs = connection.needs_base_url === true || !connection.base_url;

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await api.PATCH('/api/v1/workspaces/{ws}/connections/{id}', {
        params: { path: { ws, id: connection.id } },
        body: { base_url: value.trim() } as never,
      } as never);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${connection.name} now sends its credential only to ${value.trim()}`);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['connections', ws] });
    },
    // The server is the authority: its own sentence is shown if it disagrees with the check above.
    onError: (error) => toast.error(apiErrorMessage(error, 'Could not save the base URL. Nothing changed.')),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setValue(connection.base_url ?? '');
          setTouched(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant={needs ? 'primary' : 'ghost'} size="sm">
          {needs ? 'Set base URL' : 'Base URL'}
        </Button>
      </DialogTrigger>
      <DialogContent title={`Base URL for “${connection.name}”`}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!problem) save.mutate();
          }}
        >
          <p className="text-body text-muted">
            The one address this connection&rsquo;s credential may be sent to: the host and, if you like, a path prefix. A rule that
            points anywhere else is refused, so nobody who writes a rule can send the credential to their own server.
            {needs && ' This connection has none yet, so it sends nothing until you set one.'}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="http-conn-base-url">Base URL</Label>
            <Input
              id="http-conn-base-url"
              autoFocus
              inputMode="url"
              placeholder="https://api.example.com/v1"
              value={value}
              aria-invalid={touched && problem ? true : undefined}
              aria-describedby={touched && problem ? 'http-conn-base-url-problem' : undefined}
              onChange={(e) => setValue(e.target.value)}
            />
            {touched && problem && (
              <p id="http-conn-base-url-problem" role="alert" className="text-label text-error">
                {problem}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
