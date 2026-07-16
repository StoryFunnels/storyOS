'use client';

import { createContext, useContext } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BlockNoteSchema, defaultInlineContentSpecs } from '@blocknote/core';
import type { BlockNoteEditor } from '@blocknote/core';
import { SuggestionMenuController, createReactInlineContentSpec } from '@blocknote/react';
import { api } from '@/lib/api';

/**
 * @/# mentions in rich text (MN-205 part 2, #140).
 *
 * The inline node stores THE ID (plus a label snapshot as fallback) — never just a
 * name: renames must propagate and a deleted target must degrade to a tombstone,
 * not a stale string. Shape matches the MCP markdown round-trip exactly
 * ({ type: 'mention', props: { kind, id, label } }), so an agent-written
 * [@Name](user:<id>) parses into the same node this editor produces. `db` is a
 * UI-only extra (set when picked here) that makes a #record chip navigable;
 * mentions arriving via markdown render read-only until resolved.
 */
export const MentionInline = createReactInlineContentSpec(
  {
    type: 'mention',
    propSchema: {
      kind: { default: 'user' },
      id: { default: '' },
      label: { default: '' },
      db: { default: '' },
    },
    content: 'none',
  },
  {
    render: (props) => <MentionChip {...(props.inlineContent.props as MentionProps)} />,
  },
);

/** Default schema + the mention inline node — shared by every rich-text surface. */
export const mentionSchema = BlockNoteSchema.create({
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: MentionInline },
});

interface MentionProps {
  kind: string;
  id: string;
  label: string;
  db: string;
}

/** Workspace + live member names for chips rendered inside an editor. */
export const MentionScopeContext = createContext<{
  ws: string;
  memberNames: Map<string, string>;
}>({ ws: '', memberNames: new Map() });

const chipCls =
  'rounded bg-accent-soft px-1 py-0.5 text-[0.9em] font-medium text-[var(--accent)]';

function MentionChip(props: MentionProps) {
  const { ws, memberNames } = useContext(MentionScopeContext);
  if (props.kind === 'record') return <RecordChip {...props} ws={ws} />;
  // @user: live display name from the members map; the stored label is the fallback
  // so an agent-written or offline mention still reads sensibly.
  const name = memberNames.get(props.id) ?? props.label;
  return <span className={chipCls}>@{name || 'unknown'}</span>;
}

function RecordChip({ ws, id, db, label }: MentionProps & { ws: string }) {
  // Live title (store the id, render the label — MN-199): resolves when we know the
  // database; falls back to the snapshot; strikes through when the target is gone.
  const record = useQuery({
    queryKey: ['mention-record', ws, db, id],
    enabled: Boolean(ws && db && id),
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error, response } = await api.GET(
        '/api/v1/workspaces/{ws}/databases/{db}/records/{rec}',
        { params: { path: { ws, db, rec: id } } },
      );
      if (error) {
        if (response.status === 404) return { deleted: true as const };
        throw error;
      }
      return data as unknown as { title: string };
    },
  });

  const deleted = record.data && 'deleted' in record.data;
  const title = record.data && 'title' in record.data ? record.data.title : label;
  const body = (
    <span className={deleted ? `${chipCls} line-through opacity-60` : chipCls}>
      #{title || 'Untitled'}
      {deleted ? ' (deleted)' : ''}
    </span>
  );
  if (!db || deleted) return body;
  return (
    <Link href={`/w/${ws}/d/${db}/r/${id}`} className="no-underline" contentEditable={false}>
      {body}
    </Link>
  );
}

/* ---------- suggestion menus ---------- */

interface SuggestionItem {
  title: string;
  subtext?: string;
  onItemClick: () => void;
}

/** Insert a mention inline node + a trailing space at the caret. */
function insertMention(
  editor: BlockNoteEditor<never, never, never>,
  props: MentionProps,
): void {
  (editor as unknown as {
    insertInlineContent: (content: unknown[]) => void;
  }).insertInlineContent([{ type: 'mention', props }, ' ']);
}

/**
 * The @ (members) and # (records) pickers. Render as children of BlockNoteView —
 * additive to the default slash menu. The # search rides the grant-scoped
 * workspace search endpoint, so a guest is only ever offered titles they can open.
 */
export function MentionSuggestionMenus({
  editor,
  ws,
}: {
  editor: BlockNoteEditor<never, never, never>;
  ws: string;
}) {
  const getMembers = async (query: string): Promise<SuggestionItem[]> => {
    const { data, error } = await api.GET('/api/v1/workspaces/{ws}/members', {
      params: { path: { ws } },
    });
    if (error) return [];
    const members = (data as unknown as Array<{ user: { id: string; name: string } }>).map(
      (m) => m.user,
    );
    const q = query.trim().toLowerCase();
    return members
      .filter((u) => !q || u.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((u) => ({
        title: u.name,
        onItemClick: () =>
          insertMention(editor, { kind: 'user', id: u.id, label: u.name, db: '' }),
      }));
  };

  const getRecords = async (query: string): Promise<SuggestionItem[]> => {
    if (!query.trim()) return [];
    const { data, error } = await api.GET('/api/v1/workspaces/{ws}/search', {
      params: { path: { ws }, query: { q: query.trim() } },
    } as never);
    if (error) return [];
    const records = (data as unknown as {
      records: Array<{ id: string; title: string; database_id: string; database_name: string }>;
    }).records;
    return records.slice(0, 8).map((r) => ({
      title: r.title || 'Untitled',
      subtext: r.database_name,
      onItemClick: () =>
        insertMention(editor, {
          kind: 'record',
          id: r.id,
          label: r.title,
          db: r.database_id,
        }),
    }));
  };

  return (
    <>
      <SuggestionMenuController triggerCharacter="@" getItems={getMembers} />
      <SuggestionMenuController triggerCharacter="#" getItems={getRecords} />
    </>
  );
}

/** Provides ws + live member names to mention chips inside an editor tree. */
export function MentionScope({
  ws,
  children,
}: {
  ws: string;
  children: React.ReactNode;
}) {
  const members = useQuery({
    queryKey: ['members', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/members', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return data as unknown as Array<{ user: { id: string; name: string } }>;
    },
    retry: false,
    staleTime: 60_000,
  });
  const memberNames = new Map((members.data ?? []).map((m) => [m.user.id, m.user.name]));
  return (
    <MentionScopeContext.Provider value={{ ws, memberNames }}>
      {children}
    </MentionScopeContext.Provider>
  );
}
