'use client';

import { createContext, useContext, useMemo, useRef, type MutableRefObject } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { BlockNoteSchema, defaultInlineContentSpecs } from '@blocknote/core';
import type { BlockNoteEditor } from '@blocknote/core';
import type { SuggestionMenuProps } from '@blocknote/react';
import { SuggestionMenuController, createReactInlineContentSpec } from '@blocknote/react';
import { api } from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { EntityIcon } from '@/components/ui/icon-picker';
import { EntityPickerRow } from './entity-picker-row';
import {
  filterMembers,
  mentionInsertContent,
  recordMentionProps,
  recordRowLabel,
  userMentionProps,
  type MemberUser,
  type SearchRecord,
} from './mention-items';

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

/** Insert a mention inline node + a trailing space at the caret. */
function insertMention(
  editor: BlockNoteEditor<never, never, never>,
  props: MentionProps,
): void {
  (editor as unknown as {
    insertInlineContent: (content: unknown[]) => void;
  }).insertInlineContent(mentionInsertContent(props) as unknown[]);
}

/**
 * One row in a custom mention picker (#169). Carries the fully-built pieces the
 * shared row needs plus the mention node to insert on pick — keyboard ↑↓/↵ and
 * click both route through BlockNote's own `onItemClick`, which closes the menu
 * and clears the typed trigger before we insert.
 */
interface PickerItem {
  key: string;
  icon: React.ReactNode;
  title: string;
  breadcrumb?: string | null;
  idChip?: number | null;
  mention: MentionProps;
}

/** A record the caller touched recently, from GET /workspaces/{ws}/recent. */
interface RecentRecord {
  id: string;
  title: string;
  database_id: string;
  database_name: string;
}

/**
 * Fibery-parity custom renderer (#169), shared by the @ and # menus. BlockNote
 * still owns querying + keyboard selection (it passes `items`, `selectedIndex`
 * and a composed `onItemClick`); we only paint the window: a "Recent items"-style
 * header on an empty query, the shared {@link EntityPickerRow} per hit, an empty
 * prompt, and the keyboard-hint footer. The current query text isn't threaded
 * through these props, so each menu hands us a ref its own `getItems` keeps in
 * sync — enough to know whether we're in the empty-query (recents) state.
 */
function makePickerMenu(opts: {
  emptyHeader: string;
  emptyPrompt: string;
  queryRef: MutableRefObject<string>;
}) {
  return function PickerMenu({
    items,
    selectedIndex,
    onItemClick,
    loadingState,
  }: SuggestionMenuProps<PickerItem>) {
    const isEmptyQuery = opts.queryRef.current.trim() === '';
    const hasItems = items.length > 0;
    return (
      <div className="w-72 overflow-hidden rounded-[var(--radius-modal)] border border-border-default bg-card shadow-[0_16px_40px_rgba(15,23,41,0.22)]">
        {isEmptyQuery && hasItems && (
          <p className="px-2.5 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wider text-faint">
            {opts.emptyHeader}
          </p>
        )}
        <div className="max-h-64 overflow-y-auto p-1">
          {hasItems ? (
            items.map((item, i) => (
              <EntityPickerRow
                key={item.key}
                icon={item.icon}
                title={item.title}
                breadcrumb={item.breadcrumb}
                idChip={item.idChip}
                active={i === selectedIndex}
                onClick={() => onItemClick?.(item)}
              />
            ))
          ) : (
            <p className="px-2.5 py-6 text-center text-[12px] text-muted">
              {loadingState === 'loading-initial'
                ? 'Searching…'
                : isEmptyQuery
                  ? opts.emptyPrompt
                  : 'No matches'}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-border-default px-2.5 py-1.5 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <Hint>↑↓</Hint> navigate
          </span>
          <span className="flex items-center gap-1">
            <Hint>↵</Hint> insert
          </span>
          <span className="flex items-center gap-1">
            <Hint>esc</Hint> close
          </span>
        </div>
      </div>
    );
  };
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded border border-border-default bg-hover px-1 font-sans text-[10px] leading-none text-muted">
      {children}
    </kbd>
  );
}

/**
 * The @ (members) and # (records) pickers. Render as children of BlockNoteView —
 * additive to the default slash menu.
 *
 * @ offers workspace members (name-filtered locally), each row an avatar + name.
 * # rides the grant-scoped workspace search endpoint — so a guest is only ever
 * offered titles they can open — rendering the owning database's icon, the title,
 * the database as breadcrumb subtext, and the faint #<number> chip (the #227/#228
 * record-chip style). On an empty # query we show the caller's recently-touched
 * records (GET /workspaces/{ws}/recent, the same source the Cmd+K palette uses);
 * recents carry no per-database number so those rows omit the #id chip.
 */
export function MentionSuggestionMenus({
  editor,
  ws,
}: {
  editor: BlockNoteEditor<never, never, never>;
  ws: string;
}) {
  // See makePickerMenu: the live query text isn't in the menu props, so each
  // menu's getItems keeps its own query ref in sync for the empty-state header.
  const memberQuery = useRef('');
  const recordQuery = useRef('');

  const recordIcon = (icon: string | null) => (
    <EntityIcon icon={icon} color={null} fallback={<span className="text-faint">#</span>} />
  );

  const getMembers = async (query: string): Promise<PickerItem[]> => {
    memberQuery.current = query;
    const { data, error } = await api.GET('/api/v1/workspaces/{ws}/members', {
      params: { path: { ws } },
    });
    if (error) return [];
    const members = (data as unknown as Array<{ user: MemberUser }>).map((m) => m.user);
    return filterMembers(members, query)
      .slice(0, 8)
      .map((u) => ({
        key: u.id,
        icon: <Avatar userId={u.id} name={u.name} image={u.image} size={20} />,
        title: u.name,
        mention: userMentionProps(u),
      }));
  };

  const getRecords = async (query: string): Promise<PickerItem[]> => {
    recordQuery.current = query;
    const q = query.trim();

    // Empty query → the caller's recently-touched records (the existing #036
    // /recent endpoint the Cmd+K palette already reads). These have no public
    // per-database number, so no #id chip.
    if (!q) {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/recent', {
        params: { path: { ws } },
      } as never);
      if (error) return [];
      const records = (data as unknown as { records: RecentRecord[] }).records ?? [];
      return records.slice(0, 8).map((r) => ({
        key: r.id,
        icon: recordIcon((r as { database_icon?: string | null }).database_icon ?? null),
        title: r.title || 'Untitled',
        breadcrumb: r.database_name,
        mention: recordMentionProps({
          id: r.id,
          title: r.title,
          database_id: r.database_id,
          database_name: r.database_name,
        }),
      }));
    }

    const { data, error } = await api.GET('/api/v1/workspaces/{ws}/search', {
      params: { path: { ws }, query: { q } },
    } as never);
    if (error) return [];
    const records = (data as unknown as { records: SearchRecord[] }).records ?? [];
    return records.slice(0, 8).map((r) => {
      const row = recordRowLabel(r);
      return {
        key: r.id,
        icon: recordIcon((r as { database_icon?: string | null }).database_icon ?? null),
        title: row.title,
        breadcrumb: row.database,
        idChip: row.number,
        mention: recordMentionProps(r),
      };
    });
  };

  const MemberMenu = useMemo(
    () => makePickerMenu({ emptyHeader: 'People', emptyPrompt: 'Type a user name', queryRef: memberQuery }),
    [],
  );
  const RecordMenu = useMemo(
    () =>
      makePickerMenu({
        emptyHeader: 'Recent items',
        emptyPrompt: 'Type an entity or view name',
        queryRef: recordQuery,
      }),
    [],
  );

  return (
    <>
      <SuggestionMenuController
        triggerCharacter="@"
        getItems={getMembers}
        suggestionMenuComponent={MemberMenu}
        onItemClick={(item) => insertMention(editor, item.mention)}
      />
      <SuggestionMenuController
        triggerCharacter="#"
        getItems={getRecords}
        suggestionMenuComponent={RecordMenu}
        onItemClick={(item) => insertMention(editor, item.mention)}
      />
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
