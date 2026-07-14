'use client';

import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import { api } from '@/lib/api';
import { uploadEditorImage } from '@/lib/editor-upload';
import { useTheme } from '@/lib/theme';

interface SpaceDoc {
  id: string;
  space_id: string;
  title: string;
  icon: string | null;
  content: unknown;
  version: number;
}

export default function SpaceDocumentPage() {
  const { ws, doc } = useParams<{ ws: string; doc: string }>();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['space-doc', ws, doc],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/documents/{doc}', {
        params: { path: { ws, doc } },
      } as never);
      if (error) throw error;
      return data as unknown as SpaceDoc;
    },
    staleTime: Infinity,
  });

  if (query.isLoading) return <p className="p-6 text-sm text-muted">Loading…</p>;
  if (!query.data) return <p className="p-6 text-sm text-error">Document not found.</p>;
  return <DocEditor ws={ws} doc={doc} initial={query.data} onRenamed={() => qc.invalidateQueries({ queryKey: ['space-docs'] })} />;
}

function DocEditor({
  ws,
  doc,
  initial,
  onRenamed,
}: {
  ws: string;
  doc: string;
  initial: SpaceDoc;
  onRenamed: () => void;
}) {
  const versionRef = useRef(initial.version);
  const [title, setTitle] = useState(initial.title);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { resolved: theme } = useTheme();
  const editor = useCreateBlockNote({
    initialContent: Array.isArray(initial.content) && initial.content.length > 0 ? (initial.content as never) : undefined,
    uploadFile: (file: File) => uploadEditorImage(ws, file),
  });
  useEffect(() => () => (timer.current !== null ? clearTimeout(timer.current) : undefined), []);

  const save = useMutation({
    mutationFn: async (body: { title?: string; content?: unknown; expected_version?: number }) => {
      const { data, error } = await api.PATCH('/api/v1/workspaces/{ws}/documents/{doc}', {
        params: { path: { ws, doc } },
        body: body as never,
      } as never);
      if (error) throw error;
      return data as unknown as SpaceDoc;
    },
    onSuccess: (d) => {
      versionRef.current = d.version;
    },
  });

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <input
        className="mb-4 w-full bg-transparent text-3xl font-bold text-ink outline-none placeholder:text-faint"
        placeholder="Untitled"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (title !== initial.title) save.mutate({ title }, { onSuccess: onRenamed });
        }}
      />
      <BlockNoteView
        editor={editor}
        theme={theme}
        onChange={() => {
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            save.mutate({ content: editor.document, expected_version: versionRef.current });
          }, 800);
        }}
      />
    </div>
  );
}
