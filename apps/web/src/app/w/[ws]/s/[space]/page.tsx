'use client';
import { Tooltip } from '@/components/ui/tooltip';

import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileText, Layers, Lock, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { apiErrorMessage } from '@/lib/api';
import { useDatabases, useSpaces, useSidebarMutations, useWorkspace } from '@/lib/queries';
import { describeDraft } from '@/lib/description-draft';
import { GRANT_ROLES } from '@/lib/access';
import { EntityIcon, IconColorPicker } from '@/components/ui/icon-picker';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { InstallDialog } from '@/components/pack-install-dialog';
import {
  SpaceNewMenu,
  SpacePackGrid,
  StartFromScratchBar,
  useSpaceContents,
  useSpaceCreators,
} from '@/components/space-start';
import { canAddToSpace, canInstallPacks, isSpaceEmpty } from '@/lib/space-start';
import { Textarea } from '@/components/ui/textarea';
import { ManageAccessDialog } from '@/components/access/manage-access-dialog';
import { canManageAccess } from '@/lib/access-model';
import {
  RESTRICTED_PRIVATE_NOTE,
  RESTRICTED_SUMMARY,
  adminRows,
  canReadGrants,
  everyoneRows,
  spaceAccessMode,
} from '@/lib/space-access-section';
import { SpaceOntology } from '@/components/space-ontology';
import type { OntologyRelation } from '@/components/space-ontology';
import { databaseNoun, pluralNoun } from '@/lib/records';
import { cn } from '@/lib/utils';
import { databaseColor } from '@/lib/entity-color';

interface Grant {
  id: string;
  user_id: string;
  space_id: string | null;
  database_id: string | null;
  role: string;
}
interface Member {
  id: string;
  role: string;
  user_id: string;
  user: { id: string; name: string; email: string | null };
}

const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  GRANT_ROLES.map((r) => [r.value, r.label.split(' — ')[0]!]),
);

/**
 * The space page (#449) — "the container that organises everything is the one
 * thing you cannot open." Founder, 2026-08-27.
 *
 * Four things, per the ticket: identity (icon/name/description), access (who
 * can see this, and from where), the ontology (databases as nodes, relations
 * as edges — the point of the page), and a plain contents list for when the
 * sidebar is collapsed.
 *
 * ACCESS GATING — the door, not the room. This page calls the same
 * `GET /workspaces/:ws/spaces` list every sidebar already calls, which is
 * already gated on `visibleSpaceIds` server-side (`spaces.service.ts:21`) —
 * never `assertSpace`. If the requested space id is not in that list, the
 * viewer cannot see the DOOR and gets a plain message, not a 404. Once past
 * the door, `GET /workspaces/:ws/databases` is independently gated per
 * database (`databases.service.ts:123`), so a guest with a database-scoped
 * grant reaches this page and sees exactly the subset they can read — the
 * combination `docs/architecture/views-and-the-sidebar.md` names as the one
 * that must never 404.
 */
export default function SpacePage() {
  const { ws, space: spaceId } = useParams<{ ws: string; space: string }>();
  const spaces = useSpaces(ws);
  const databases = useDatabases(ws);
  const { updateSpace } = useSidebarMutations(ws);

  const workspace = useWorkspace(ws);
  // #449 — GET /members and /grants are admin/member-only (403 for a guest;
  // measured live, not assumed: "Requires member role" / "Requires admin
  // role"). Firing them anyway for a guest does two things wrong at once — an
  // avoidable 403 in the console, and an Access section that renders EMPTY
  // rather than saying why, which looks identical to "no one has access" and
  // is not the same claim. `enabled` stops the request; the section below
  // says the real reason instead of nothing.
  const canSeeAccessList = workspace.data?.role !== 'guest';

  const space = spaces.data?.find((s) => s.id === spaceId);
  const spaceDatabases = useMemo(
    () => (databases.data ?? []).filter((d) => d.spaceId === spaceId),
    [databases.data, spaceId],
  );

  const members = useQuery({
    queryKey: ['members', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/members', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return data as unknown as Member[];
    },
    enabled: canSeeAccessList,
  });
  const grants = useQuery({
    queryKey: ['grants', ws],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/grants', {
        params: { path: { ws } },
      });
      if (error) throw error;
      return (data as unknown as { data: Grant[] }).data;
    },
    // #1099 — /grants is admin-only (the Manage access dialog's own gate); a member's call is a doomed 403.
    enabled: canReadGrants(workspace.data?.role),
  });
  const relations = useQuery({
    queryKey: ['relations', ws, spaceId],
    queryFn: async () => {
      const { data, error } = await api.GET('/api/v1/workspaces/{ws}/relations', {
        params: { path: { ws }, query: { space: spaceId } } as never,
      } as never);
      if (error) throw error;
      return (data as unknown as { data: OntologyRelation[] }).data;
    },
    enabled: Boolean(spaceId),
  });

  // #1094 — what the viewer may ADD here, and whether there is anything here yet. Read before the early returns (hooks), and
  // both fail safe: a guest is never offered a creator, and nothing is called "empty" until every list has answered.
  const canAdd = canAddToSpace(workspace.data?.role);
  const packsOk = canInstallPacks(workspace.data?.role);
  const contents = useSpaceContents(ws, spaceId, canAdd);
  const creators = useSpaceCreators(ws, spaceId);
  const [packPicker, setPackPicker] = useState(false);
  const [installSlug, setInstallSlug] = useState<string | null>(null);

  const [descValue, setDescValue] = useState<string | null>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [iconing, setIconing] = useState(false);
  const [sharing, setSharing] = useState(false);

  const draft = describeDraft(descValue ?? space?.description ?? '');

  // #449 — loading and "not visible" are DIFFERENT states, and conflating them
  // is exactly the leak the ticket's access section warns about: a spinner that
  // never resolves reads the same as "this does not exist", which tells a guest
  // nothing about WHY. Loading first; only once the list has actually returned
  // do we say the space cannot be seen.
  if (spaces.isLoading) {
    return <div className="p-4 sm:p-8 text-body text-muted">Loading…</div>;
  }
  if (!space) {
    return (
      <div className="p-4 sm:p-8">
        <p className="max-w-md rounded-[var(--radius-card)] border border-border-default bg-card p-6 text-body text-muted">
          Nothing here you can access, or this space does not exist.
        </p>
      </div>
    );
  }

  // #1094 — "empty" needs every list to have answered (a full space must never flash the empty state) and a person who may add.
  const known = !databases.isLoading && contents.settled;
  const empty =
    canAdd &&
    known &&
    isSpaceEmpty({ databases: spaceDatabases.length, documents: contents.documents.length, views: contents.views.length });

  const spaceNameById = new Map((spaces.data ?? []).map((s) => [s.id, s.name]));

  // #1099 — "every member has access" is true only of an UNRESTRICTED space (ADR-0018).
  const accessMode = spaceAccessMode({ restricted: space.restricted, workspaceRole: workspace.data?.role });
  const spaceDbIds = new Set(spaceDatabases.map((d) => d.id));
  const spaceGrants = (grants.data ?? []).filter((g) => g.space_id === space.id);
  const dbGrants = (grants.data ?? []).filter(
    (g) => g.database_id && spaceDbIds.has(g.database_id),
  );
  const nameOf = (userId: string) =>
    (members.data ?? []).find((m) => m.user_id === userId)?.user.name ?? userId.slice(0, 8);
  const dbNameOf = (id: string) => spaceDatabases.find((d) => d.id === id)?.name ?? 'a database';

  const saveDescription = () => {
    if (draft.over) return;
    updateSpace.mutate(
      { id: space.id, description: draft.value },
      {
        onSuccess: () => {
          toast.success('Description saved');
          setEditingDesc(false);
          setDescValue(null);
        },
        onError: (e) => toast.error(apiErrorMessage(e, 'Could not save — try again')),
      },
    );
  };

  return (
    // max-md:pb-24 — below `md` the floating Quick add button covers the bottom-right corner; this page ends in the Access list,
    // so its last row must scroll clear of it (the same clearance as #1120's FAB_CLEARANCE_PB, which `sm:p-8` would override).
    <div className="mx-auto flex max-w-[1260px] flex-col gap-6 p-4 sm:p-8 max-md:pb-24">
      <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
      {/* Identity */}
      <div className="mb-1 flex items-center gap-3">
        {/*
          #449 — a REAL fallback glyph, not null. The sidebar's own space icon
          can render nothing when unset (#305: unconfigured is not invalid,
          decorative there); this one is the BUTTON itself, and a null fallback
          made it a zero-width, invisible-but-technically-present control —
          caught live by trying to click it, not in review. Shape matches the
          established "change icon" trigger in view-toolbar.tsx: a fixed-size
          bordered square with a real fallback icon, not a shared component
          (there isn't one for this), but the same proportions rather than an
          invented one.
        */}
        <Tooltip label="Change icon">
        <button
          type="button"
          onClick={() => setIconing(true)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded border border-border-default hover:bg-hover"
          aria-label="Change icon"
        >
          <EntityIcon
            icon={space.icon}
            color={space.color}
            size={20}
            fallback={
              // #706 — KEEPS faint: this is the icon-only fallback shown when a
              // space has no icon of its own. A non-text graphic, judged at 3:1,
              // which faint clears. The space NAME beside it carries the meaning.
              <Layers className="h-4 w-4 text-faint" />
            }
          />
        </button>
        </Tooltip>
        <h1 className="text-xl font-semibold text-ink">{space.name}</h1>
      </div>

      {editingDesc ? (
        <div className="flex max-w-xl flex-col gap-2">
          <Textarea
            autoFocus
            rows={2}
            size="default"
            value={descValue ?? space.description ?? ''}
            onChange={(e) => setDescValue(e.target.value)}
            placeholder="What is this space for?"
            className={cn('min-h-0 w-full resize-none', draft.over && 'border-error')}
          />
          <div className="flex items-center gap-2">
            <span
              className={cn('text-label tabular-nums', draft.over ? 'text-error' : 'text-muted')}
            >
              {draft.hint}
            </span>
            <div className="ml-auto flex gap-2">
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setEditingDesc(false);
                  setDescValue(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={saveDescription}
                disabled={draft.over || updateSpace.isPending}
              >
                {updateSpace.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditingDesc(true)}
          className="block max-w-xl text-left text-body text-muted hover:text-ink"
        >
          {space.description || 'Add a description…'}
        </button>
      )}

      </div>
      {/* #1094 — the header's two actions. Access is a jump to the Access section below (nothing about it moved out of the page),
          so who can see this space is one click from the name; New is how a space gets its first thing. */}
      <div className="flex shrink-0 items-center gap-1.5 max-sm:w-full">
        {accessMode !== 'guest' && (
          <Button
            type="button"
            variant="secondary"
            onClick={() => document.getElementById('space-access')?.scrollIntoView({ block: 'start' })}
          >
            {space.restricted ? <Lock className="h-3.5 w-3.5" aria-hidden /> : <Users className="h-3.5 w-3.5" aria-hidden />}
            {space.restricted ? 'Restricted' : 'Everyone'}
          </Button>
        )}
        {canAdd && (
          <SpaceNewMenu
            busy={creators.busy}
            onDatabase={creators.addDatabase}
            onDocument={creators.addDocument}
            onPack={packsOk ? () => setPackPicker(true) : undefined}
          />
        )}
      </div>
      </div>

      {!known ? (
        <p className="text-body text-muted">Loading…</p>
      ) : empty ? (
        <>
          <StartFromScratchBar packs={packsOk} busy={creators.busy} onDatabase={creators.addDatabase} onDocument={creators.addDocument} />
          {packsOk && (
            <section>
              <h2 className="mb-2 text-label font-semibold text-muted">What is this space for?</h2>
              <SpacePackGrid onPick={setInstallSlug} />
            </section>
          )}
          <p className="text-label text-muted">Contents and relations appear here once the space has something in it.</p>
        </>
      ) : (
        <>
      {/* Contents */}
      <section>
        <h2 className="mb-2 text-sm font-medium text-ink">Contents</h2>
        {spaceDatabases.length + contents.documents.length + contents.views.length === 0 ? (
          <p className="text-body text-muted">No databases here that you can access.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {spaceDatabases.map((d) => (
              <li key={d.id}>
                <a
                  href={`/w/${ws}/d/${d.id}`}
                  className="flex items-center gap-2 rounded px-2 py-1 text-body text-ink hover:bg-hover"
                >
                  <EntityIcon icon={d.icon} color={databaseColor(d.color, d.id)} fallback={null} />
                  <span className="truncate">{d.name}</span>
                  <span className="ml-auto text-label text-muted">database</span>
                </a>
              </li>
            ))}
            {contents.documents.map((d) => (
              <li key={d.id}>
                <a
                  href={`/w/${ws}/doc/${d.id}`}
                  className="flex items-center gap-2 rounded px-2 py-1 text-body text-ink hover:bg-hover"
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                  <span className="truncate">{d.title || 'Untitled'}</span>
                  <span className="ml-auto text-label text-muted">document</span>
                </a>
              </li>
            ))}
            {contents.views.map((v) => (
              <li key={v.id}>
                <a
                  href={`/w/${ws}/v/${v.id}`}
                  className="flex items-center gap-2 rounded px-2 py-1 text-body text-ink hover:bg-hover"
                >
                  <Layers className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                  <span className="truncate">{v.name}</span>
                  <span className="ml-auto text-label text-muted">view</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Ontology */}
      <section>
        <h2 className="mb-1 text-sm font-medium text-ink">Ontology</h2>
        <p className="mb-3 text-body text-muted">
          {/* #636 — there is only ONE rendering now, so this caption no longer
              has to describe which of two the component picked (#509's
              question, which the redesign made moot along with
              DIAGRAM_NODE_LIMIT). It does have to be honest that the diagram
              centres on one database and the Contents list below carries the
              rest. */}
          {spaceDatabases.length} {pluralNoun(databaseNoun('database'), spaceDatabases.length)}. The
          diagram centres on the most connected one; hover a chip for the relationship type, and see
          Contents below for everything here.
        </p>
        <SpaceOntology
          ws={ws}
          spaceId={space.id}
          databases={spaceDatabases.map((d) => ({
            id: d.id,
            name: d.name,
            icon: d.icon,
            color: d.color,
            description: d.description,
            recordCounter: (d as unknown as { recordCounter?: number }).recordCounter,
          }))}
          relations={relations.data ?? []}
          spaceNameById={spaceNameById}
        />
      </section>

        </>
      )}


      {/* Access */}
      <section id="space-access" className="scroll-mt-4 border-t border-border-default pt-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <Users className="h-3.5 w-3.5" /> Access
          </h2>
          {/* #449 — same gate as the API: /grants 403s below admin, so a
              button that opens a dialog doomed to 403 is worse than no button.
              This mirrors the sidebar's own `canEdit &&` gate on the identical
              menu item (sidebar.tsx), not a new rule invented for this page. */}
          {canManageAccess(workspace.data?.role) && (
            <Button type="button" variant="secondary" size="sm" onClick={() => setSharing(true)}>
              Manage access
            </Button>
          )}
        </div>
        {accessMode !== 'guest' ? (
          <div className="flex flex-col gap-3 text-body">
            {accessMode === 'everyone' ? (
              <AccessGroup
                label="Workspace members"
                hint="admin or member — access to every non-personal space"
                rows={everyoneRows(members.data ?? [])}
              />
            ) : (
              <>
                <p className="flex items-start gap-1.5 text-muted">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>{accessMode === 'restricted-admin' ? RESTRICTED_SUMMARY : `${RESTRICTED_SUMMARY} ${RESTRICTED_PRIVATE_NOTE}`}</span>
                </p>
                {accessMode === 'restricted-admin' && (
                  <AccessGroup
                    label="Workspace admins"
                    hint="admins always see a restricted space"
                    rows={adminRows(members.data ?? [])}
                  />
                )}
              </>
            )}
            <AccessGroup
              label="Granted on this space"
              hint="a space-level grant"
              rows={spaceGrants.map((g) => ({
                name: nameOf(g.user_id),
                role: ROLE_LABEL[g.role] ?? g.role,
              }))}
            />
            <AccessGroup
              label="Granted on a database here"
              hint="scoped to one database, not the whole space"
              rows={dbGrants.map((g) => ({
                name: nameOf(g.user_id),
                role: `${ROLE_LABEL[g.role] ?? g.role} · ${dbNameOf(g.database_id!)}`,
              }))}
            />
          </div>
        ) : (
          <p className="text-body text-muted">
            Only workspace admins and members can see who else has access.
          </p>
        )}
      </section>


      {creators.dialog}

      {/* #1094 — "From a pack…" on a space that already has things in it: the same cards, in a dialog. */}
      <Dialog open={packPicker} onOpenChange={setPackPicker}>
        {packPicker && (
          <DialogContent title={`Add a pack to "${space.name}"`} className="max-h-[calc(100vh-32px)] max-w-[1100px] overflow-auto">
            <SpacePackGrid
              onPick={(slug) => {
                setPackPicker(false);
                setInstallSlug(slug);
              }}
            />
          </DialogContent>
        )}
      </Dialog>

      {installSlug && (
        <InstallDialog
          ws={ws}
          slug={installSlug}
          target={{ id: space.id, name: space.name }}
          onOpenChange={(open) => !open && setInstallSlug(null)}
        />
      )}

      <Dialog open={iconing} onOpenChange={setIconing}>
        {iconing && (
          <DialogContent title={`Icon for "${space.name}"`} className="max-w-fit">
            <IconColorPicker
              icon={space.icon}
              color={space.color}
              onChange={(patch) => updateSpace.mutate({ id: space.id, ...patch })}
            />
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={sharing} onOpenChange={setSharing}>
        {sharing && <ManageAccessDialog ws={ws} scope={{ space_id: space.id }} />}
      </Dialog>
    </div>
  );
}

function AccessGroup({
  label,
  hint,
  rows,
}: {
  label: string;
  hint: string;
  rows: Array<{ name: string; role: string }>;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-meta font-medium uppercase tracking-wider text-muted" title={hint}>
        {label}
      </p>
      <ul className="flex flex-col gap-0.5">
        {rows.map((r, i) => (
          <li
            key={i}
            className="flex items-center justify-between rounded px-2 py-1 hover:bg-hover"
          >
            <span className="text-ink">{r.name}</span>
            <span className="text-muted">{r.role}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
