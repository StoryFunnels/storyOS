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
import { useTheme } from '@/lib/theme';
import { MarkdownActions } from '@/components/entity/markdown-actions';
import {
  MentionScope,
  MentionSuggestionMenus,
  mentionSchema,
} from '@/components/entity/mentions';
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
  const { resolved: theme } = useTheme();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const editor = useCreateBlockNote({
    schema: mentionSchema,
    initialContent:
      initial.content && initial.content.length > 0 ? (initial.content as never) : undefined,
    uploadFile: (file: File) => uploadEditorImage(ws, file),
  });

  const save = useMutation({
    mutationFn: async (content: Block[] | unknown[]) => {
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
                save.mutate(editor.document as never);
                qcInvalidate();
              }}
            >
              Keep mine
            </Button>
          </span>
        </div>
      )}
      <div className="flex items-center justify-end">
        <MarkdownActions editor={editor} filename="description" />
      </div>
      {/* #642 — was min-h-40 (160px), reserved regardless of content: an empty
          description held the full 160px for one placeholder line, 73-112px
          more than the content needed. min-h-12 (48px) keeps a real click
          target without the dead space.

          #642 — the alignment break (globals.css's own comment names this as
          "ticketed separately, not fixed here"): `.bn-root .bn-editor` carries
          a hard-floor 52px left padding — BlockNote's insert/drag-handle side
          menu, load-bearing, can't just be removed. That pushes the PROSE
          TEXT 52px inside this box, while the box itself already sits flush
          at the column edge (verified live: bn-editor's own rect starts at
          the same x as the title and the relation boxes above it) — so the
          text alone reads as indented against everything else. Pulling the
          box 52px further left (and widening it by the same 52px, so its
          RIGHT edge doesn't move) puts the text back at the column edge,
          with the drag handle now sitting in the reclaimed margin outside
          the visible content — exactly what the comment above asks for. */}
      <div className="-ml-[52px] w-[calc(100%+52px)] min-h-12 rounded-[var(--radius-card)] border border-border-default bg-card py-3 [&_.bn-editor]:bg-transparent">
        <MentionScope ws={ws}>
          <BlockNoteView
            /* #338: BlockNote mounts its own "/" menu unless this is off, and it
               wins over the reordered one in MentionSuggestionMenus. */
            slashMenu={false}
            editor={editor}
            editable={!readOnly && !conflict}
            theme={theme}
            onChange={() => {
              if (readOnly) return;
              setSaving(true);
              if (timer.current !== null) clearTimeout(timer.current);
              timer.current = setTimeout(() => save.mutate(editor.document as never), 800);
            }}
          >
            <MentionSuggestionMenus editor={editor as never} ws={ws} />
          </BlockNoteView>
        </MentionScope>
      </div>
      <p className="text-right text-[11px] text-faint">{saving ? 'Saving…' : 'Saved'}</p>
    </div>
  );
}
