'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import type { Block } from '@blocknote/core';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { uploadEditorImage } from '@/lib/editor-upload';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';

interface DocumentPayload {
  content: Block[] | null;
  version: number;
}

/**
 * Single-editor BlockNote description (D1): debounced autosave with optimistic
 * concurrency — a 409 surfaces the conflict banner, never silent loss.
 */
export function DescriptionEditor({
  ws,
  db,
  rec,
  readOnly,
}: {
  ws: string;
  db: string;
  rec: string;
  readOnly: boolean;
}) {
  const qc = useQueryClient();
  const doc = useQuery({
    queryKey: ['document', ws, db, rec],
    queryFn: async () => {
      const { data, error } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/document',
        { params: { path: { ws, db, rec } } },
      );
      if (error) throw error;
      return data as unknown as DocumentPayload;
    },
    staleTime: Infinity,
  });

  if (doc.isLoading) return <p className="text-sm text-muted">Loading description…</p>;
  return <EditorInner key={rec} ws={ws} db={db} rec={rec} readOnly={readOnly} initial={doc.data!} qcInvalidate={() => void qc.invalidateQueries({ queryKey: ['document', ws, db, rec] })} />;
}

function EditorInner({
  ws,
  db,
  rec,
  readOnly,
  initial,
  qcInvalidate,
}: {
  ws: string;
  db: string;
  rec: string;
  readOnly: boolean;
  initial: DocumentPayload;
  qcInvalidate: () => void;
}) {
  const versionRef = useRef(initial.version);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useCreateBlockNote({
    initialContent: initial.content && initial.content.length > 0 ? initial.content : undefined,
    uploadFile: (file: File) => uploadEditorImage(ws, file),
  });

  const save = useMutation({
    mutationFn: async (content: Block[]) => {
      const { data, error, response } = await api.PUT(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/document',
        {
          params: { path: { ws, db, rec } },
          body: { content: content as never, expected_version: versionRef.current },
        },
      );
      if (error) {
        if (response.status === 409) setConflict(true);
        throw error;
      }
      return data as unknown as { version: number };
    },
    onSuccess: (data) => {
      versionRef.current = data.version;
      setSaving(false);
    },
    onError: () => setSaving(false),
  });

  useEffect(() => () => timer.current !== null ? clearTimeout(timer.current) : undefined, []);

  return (
    <div className="flex flex-col gap-2">
      {conflict && (
        <div className="flex items-center justify-between rounded-[var(--radius-card)] border border-warning bg-accent-soft px-3 py-2 text-[13px] text-ink">
          <span>This description was edited elsewhere. Your latest change was not saved.</span>
          <span className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
              Reload theirs
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                // Overwrite: fetch the current version, then write ours on top of it.
                const { data } = await api.GET(
                  '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/document',
                  { params: { path: { ws, db, rec } } },
                );
                versionRef.current = (data as unknown as DocumentPayload).version;
                setConflict(false);
                save.mutate(editor.document);
                qcInvalidate();
              }}
            >
              Keep mine
            </Button>
          </span>
        </div>
      )}
      <div className="min-h-40 rounded-[var(--radius-card)] border border-border-default bg-card py-3 [&_.bn-editor]:bg-transparent">
        <BlockNoteView
          editor={editor}
          editable={!readOnly && !conflict}
          theme="light"
          onChange={() => {
            if (readOnly) return;
            setSaving(true);
            if (timer.current !== null) clearTimeout(timer.current);
            timer.current = setTimeout(() => save.mutate(editor.document), 800);
          }}
        />
      </div>
      <p className="text-right text-[11px] text-faint">{saving ? 'Saving…' : 'Saved'}</p>
    </div>
  );
}
