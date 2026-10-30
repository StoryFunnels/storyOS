'use client';

import { Lock } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { RoleMenu } from '@/components/access/role-menu';
import { cn } from '@/lib/utils';
import {
  ROLE_WORDS,
  accessCards,
  accessView,
  addablePeople,
  nameList,
  openPreview,
  restrictPreview,
} from '@/lib/access-model';
import type { AccessCard, Grant, GrantRole, Person, PersonRow, Target } from '@/lib/access-model';

/**
 * #924 — the pieces of the Share / Manage access dialog, presentational: the container (`manage-access-dialog.tsx`) owns
 * the data and the writes, these draw `lib/access-model.ts`'s answers. Every state in Dara's design is one of these.
 */
const SECTION = 'text-meta font-semibold uppercase tracking-wider text-muted';
const ROW = 'flex min-h-10 items-center gap-2.5 border-b border-border-default px-3 py-2 last:border-b-0 max-md:min-h-12';

export function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className={SECTION}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="overflow-hidden rounded-[var(--radius-card)] border border-border-default bg-card">{children}</div>
);

/** One line of the list: who, a subline, and the control (or the fixed word) at the right. */
export function PersonLine({ person, subline, right }: { person: Person; subline?: string; right: React.ReactNode }) {
  return (
    <div className={ROW}>
      <Avatar userId={person.userId} name={person.name} size={24} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-medium text-ink">{person.name}</span>
        {subline && <span className="truncate text-label text-muted">{subline}</span>}
      </span>
      {right}
    </div>
  );
}

const Fixed = ({ children }: { children: React.ReactNode }) => (
  <span className="shrink-0 px-2 text-label font-medium text-muted">{children}</span>
);

export function AccessCards({
  cards,
  selected,
  onPick,
  disabled,
}: {
  cards: AccessCard[];
  selected: AccessCard['key'];
  onPick: (key: AccessCard['key']) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Who can see this" className="grid gap-2 sm:grid-cols-2">
      {cards.map((c) => (
        <button
          key={c.key}
          type="button"
          role="radio"
          aria-checked={selected === c.key}
          disabled={disabled}
          onClick={() => selected !== c.key && onPick(c.key)}
          className={cn(
            'flex flex-col gap-1 rounded-[var(--radius-card)] border px-3 py-2.5 text-left transition-colors max-md:min-h-14',
            selected === c.key ? 'border-ink bg-card shadow-[inset_0_0_0_1px_var(--text-primary)]' : 'border-border-default bg-card hover:border-border-strong',
          )}
        >
          <span className="flex items-center gap-1.5 text-body font-semibold text-ink">
            {c.key === 'restricted' && <Lock className="h-3 w-3 text-muted" aria-hidden />}
            {c.label}
          </span>
          <span className="text-label text-muted">{c.consequence}</span>
        </button>
      ))}
    </div>
  );
}

/** The add box: a search that lists, IN FLOW under the input (so it cannot fall off a phone's sheet), the people who can be added. */
export function AddPeople({
  people,
  label,
  withRole,
  onAdd,
}: {
  people: Person[];
  label: string;
  /** Restricted mode adds with a role picked here, default Editor; everyone mode adds guests at their own pick too. */
  withRole: boolean;
  onAdd: (person: Person, role: GrantRole) => void;
}) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<GrantRole>('editor');
  const [focused, setFocused] = useState(false);
  const matches = people.filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const showList = focused || query.length > 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={query}
          placeholder={label}
          aria-label={label}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          className="h-9 min-w-0 flex-1 rounded-[var(--radius-control)] border border-border-default bg-card px-3 text-body text-ink placeholder:text-muted max-md:h-10"
        />
        {withRole && <RoleMenu role={role} onChange={setRole} label="the person you add" />}
      </div>
      {showList &&
        (matches.length > 0 ? (
          <ul className="max-h-48 overflow-y-auto rounded-[var(--radius-card)] border border-border-default bg-card">
            {matches.map((p) => (
              <li key={p.userId}>
                <button
                  type="button"
                  onClick={() => {
                    onAdd(p, role);
                    setQuery('');
                    setFocused(false);
                  }}
                  className="flex min-h-10 w-full items-center gap-2.5 px-3 py-1.5 text-left hover:bg-hover max-md:min-h-12"
                >
                  <Avatar userId={p.userId} name={p.name} size={24} />
                  <span className="min-w-0 flex-1 truncate text-body text-ink">{p.name}</span>
                  <span className="text-label capitalize text-muted">{p.workspaceRole}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-[var(--radius-control)] bg-hover px-3 py-2 text-label text-muted">
            {query ? `Nobody called “${query}” to add. ` : 'Everyone who can be added already has access. '}
            Invite them from Settings → Members first.
          </p>
        ))}
    </div>
  );
}

function GrantRows({
  rows,
  targetName,
  inSpaceName,
  onRole,
  onRemove,
}: {
  rows: PersonRow[];
  targetName: string;
  inSpaceName?: string;
  onRole: (row: PersonRow, role: GrantRole) => void;
  onRemove: (row: PersonRow) => void;
}) {
  return (
    <Card>
      {rows.map((r) => (
        <PersonLine
          key={r.person.userId}
          person={r.person}
          subline={
            r.alsoFromSpaceRole && inSpaceName
              ? `${ROLE_WORDS[r.alsoFromSpaceRole].label} from ${inSpaceName}, the higher role wins`
              : r.person.workspaceRole === 'guest'
                ? 'Guest'
                : 'Member'
          }
          right={
            <RoleMenu
              role={r.role!}
              label={`${r.person.name} on ${targetName}`}
              onChange={(role) => onRole(r, role)}
              onRemove={() => onRemove(r)}
            />
          }
        />
      ))}
    </Card>
  );
}

/** The dialog's main step: the cards, then whichever of the six states the target is in. */
export function AccessMain({
  target,
  people,
  grants,
  onPickCard,
  onRole,
  onRemove,
  onAdd,
  onOpenSpace,
}: {
  target: Target;
  people: Person[];
  grants: Grant[];
  onPickCard: (key: AccessCard['key']) => void;
  onRole: (row: PersonRow, role: GrantRole) => void;
  onRemove: (row: PersonRow) => void;
  onAdd: (person: Person, role: GrantRole) => void;
  /** Reopen the dialog on the space (the "Manage <space>'s access" link). */
  onOpenSpace?: () => void;
}) {
  const v = accessView(target, people, grants);
  const addable = addablePeople(target, people, grants);
  const spaceName = target.kind === 'database' ? target.space.name : '';

  if (v.mode === 'system') {
    return (
      <p className="rounded-[var(--radius-control)] bg-hover px-3 py-2.5 text-body text-muted">
        “{target.name}” is a system database: it cannot be restricted, because the people pickers across the workspace read it.
      </p>
    );
  }

  const adminRows = v.admins.map((a) => <PersonLine key={a.userId} person={a} subline="Admin" right={<Fixed>Always has access</Fixed>} />);
  const restrictedLike = v.mode === 'restricted' || v.mode === 'inherited';

  return (
    <div className="flex flex-col gap-4">
      <AccessCards cards={accessCards(target)} selected={v.mode === 'restricted' ? 'restricted' : 'everyone'} onPick={onPickCard} />

      {v.mode === 'everyone' && v.everyone && (
        <Section title="People with access">
          <Card>
            <div className={ROW}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-body font-medium text-ink">
                  {target.kind === 'database' && target.space.restricted ? `Everyone in ${spaceName}` : 'Everyone in the workspace'}
                </span>
                <span className="text-label text-muted">
                  {v.everyone.admins} {v.everyone.admins === 1 ? 'admin' : 'admins'}, {v.everyone.members}{' '}
                  {v.everyone.members === 1 ? 'member' : 'members'}
                </span>
              </span>
              <Fixed>Creator</Fixed>
            </div>
            {v.added.map((r) => (
              <PersonLine
                key={r.person.userId}
                person={r.person}
                subline="Guest"
                right={<RoleMenu role={r.role!} label={`${r.person.name} on ${target.name}`} onChange={(role) => onRole(r, role)} onRemove={() => onRemove(r)} />}
              />
            ))}
            {v.inherited.map((r) => (
              <PersonLine key={r.person.userId} person={r.person} subline={`Guest · from ${spaceName}`} right={<Fixed>{ROLE_WORDS[r.role!].label}</Fixed>} />
            ))}
          </Card>
          {v.membersWithGrants.length > 0 && (
            <p className="text-label text-muted">
              {nameList(v.membersWithGrants.map((m) => m.name))} {v.membersWithGrants.length === 1 ? 'holds' : 'hold'} a grant here and{' '}
              {v.membersWithGrants.length === 1 ? 'keeps' : 'keep'} access if this is restricted.
            </p>
          )}
        </Section>
      )}

      {v.mode === 'restricted' && (
        <Section title={`People with access · ${v.admins.length + v.added.length}`}>
          <Card>
            {adminRows}
            {v.added.map((r) => (
              <PersonLine
                key={r.person.userId}
                person={r.person}
                subline={r.person.workspaceRole === 'guest' ? 'Guest' : 'Member'}
                right={<RoleMenu role={r.role!} label={`${r.person.name} on ${target.name}`} onChange={(role) => onRole(r, role)} onRemove={() => onRemove(r)} />}
              />
            ))}
          </Card>
          {v.empty && (
            <p className="rounded-[var(--radius-card)] border border-dashed border-border-strong px-3 py-3 text-body text-muted">
              Only admins can see “{target.name}” right now. Add the people who need it — members or guests.
            </p>
          )}
          {v.stickyHidden.length > 0 && (
            <p role="note" className="rounded-[var(--radius-control)] border border-border-default bg-hover px-3 py-2 text-label text-ink">
              {nameList(v.stickyHidden.map((p) => p.name))} {v.stickyHidden.length === 1 ? 'has' : 'have'} access to {spaceName} but{' '}
              {v.stickyHidden.length === 1 ? 'does not' : 'do not'} see this database. Add {v.stickyHidden.length === 1 ? 'them' : 'them'} here to let them in.
            </p>
          )}
        </Section>
      )}

      {v.mode === 'inherited' && (
        <>
          <Section title="Admins">
            <Card>{adminRows}</Card>
          </Section>
          <Section
            title={`From ${spaceName} · ${v.inherited.length}`}
            action={
              onOpenSpace && (
                <button type="button" onClick={onOpenSpace} className="text-label font-medium text-primary-text underline">
                  Manage {spaceName}&rsquo;s access →
                </button>
              )
            }
          >
            <Card>
              {v.inherited.length === 0 && <p className="px-3 py-2 text-label text-muted">Nobody but admins has access to {spaceName} yet.</p>}
              {v.inherited.map((r) => (
                <PersonLine
                  key={r.person.userId}
                  person={r.person}
                  subline={r.person.workspaceRole === 'guest' ? 'Guest' : 'Member'}
                  right={<Fixed>{ROLE_WORDS[r.role!].label}</Fixed>}
                />
              ))}
            </Card>
          </Section>
          <Section title={`Added here · ${v.added.length}`}>
            {v.added.length > 0 ? (
              <GrantRows rows={v.added} targetName={target.name} inSpaceName={spaceName} onRole={onRole} onRemove={onRemove} />
            ) : (
              <p className="text-label text-muted">Nobody was added to this database directly.</p>
            )}
          </Section>
        </>
      )}

      <AddPeople people={addable} label={v.mode === 'everyone' ? 'Add a guest…' : 'Add people…'} withRole={true} onAdd={onAdd} />

      {restrictedLike && (
        <p className="text-label text-muted">
          People without access don&rsquo;t see “{target.name}” anywhere: not in the sidebar, search, links or mentions.
        </p>
      )}
    </div>
  );
}

/** Everyone → Restricted: who loses access, with a "Keep" tick each. Nothing is saved until the confirm. */
export function RestrictStep({
  target,
  people,
  grants,
  keep,
  onToggle,
  busy,
  onCancel,
  onConfirm,
}: {
  target: Target;
  people: Person[];
  grants: Grant[];
  keep: ReadonlySet<string>;
  onToggle: (userId: string) => void;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const lose = restrictPreview(target, people, grants);
  const keeping = people.filter((p) => p.workspaceRole !== 'admin' && grants.some((g) => (target.kind === 'space' ? g.spaceId === target.id : g.databaseId === target.id) && g.userId === p.userId));
  const removed = lose.filter((l) => !keep.has(l.person.userId)).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-muted">
        {lose.length === 0
          ? `Nobody but admins can see “${target.name}” today, so nobody loses access.`
          : `${lose.length} ${lose.length === 1 ? 'person can' : 'people can'} see it now and won't once it's restricted. Tick anyone who should keep access.`}
      </p>
      {lose.length > 0 && (
        <Card>
          {lose.map((l) => (
            <label key={l.person.userId} className={cn(ROW, 'cursor-pointer')}>
              <Avatar userId={l.person.userId} name={l.person.name} size={24} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-body font-medium text-ink">{l.person.name}</span>
                <span className="truncate text-label text-muted">
                  {l.person.workspaceRole === 'guest' ? 'Guest' : 'Member'}
                  {l.via === 'space' ? ' · through the space' : ''}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2 text-label text-ink">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-[var(--primary)] max-md:h-5 max-md:w-5"
                  checked={keep.has(l.person.userId)}
                  onChange={() => onToggle(l.person.userId)}
                  aria-label={`Keep ${l.person.name} as ${ROLE_WORDS[l.keepAs].label}`}
                />
                Keep as {ROLE_WORDS[l.keepAs].label}
              </span>
            </label>
          ))}
        </Card>
      )}
      <p className="text-label text-muted">
        {keeping.length > 0 && `${nameList(keeping.map((p) => p.name))} already ${keeping.length === 1 ? 'has' : 'have'} access and keep${keeping.length === 1 ? 's' : ''} it. `}
        Admins always keep access.
      </p>
      <div className="flex justify-end gap-2 max-md:flex-col-reverse">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" variant={removed > 0 ? 'destructive' : 'primary'} onClick={onConfirm} disabled={busy}>
          {busy ? 'Restricting…' : removed > 0 ? `Restrict — remove ${removed} ${removed === 1 ? 'person' : 'people'}` : 'Restrict'}
        </Button>
      </div>
    </div>
  );
}

/** Restricted → Everyone: names the role widening. Not red, but never silent about who gains what. */
export function OpenStep({
  target,
  people,
  grants,
  restrictedDatabaseNames,
  busy,
  onCancel,
  onConfirm,
}: {
  target: Target;
  people: Person[];
  grants: Grant[];
  restrictedDatabaseNames: string[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const p = openPreview(target, people, grants, restrictedDatabaseNames);
  const spaceName = target.kind === 'database' ? target.space.name : '';
  return (
    <div className="flex flex-col gap-3">
      {p.withinSpace ? (
        <p className="text-body text-ink">
          Everyone who can open {spaceName} will see “{target.name}”
          {p.gaining.length > 0 && <>, including {nameList(p.gaining.map((g) => g.name))} for the first time</>}.
        </p>
      ) : (
        <p className="text-body text-ink">
          All {p.members} {p.members === 1 ? 'member' : 'members'} will see it as creators
          {p.gaining.length > 0 && <> — {nameList(p.gaining.map((g) => g.name))} for the first time</>}.
        </p>
      )}
      {p.widening.length > 0 && (
        <p className="rounded-[var(--radius-control)] border border-border-default bg-hover px-3 py-2 text-label text-ink">
          That includes {nameList(p.widening.map((w) => `${w.person.name} (${ROLE_WORDS[w.today].label} here today)`))}. A member&rsquo;s role here is ignored once it is open to everyone.
        </p>
      )}
      {p.staysClosed.length > 0 && (
        <p className="text-label text-muted">
          Its restricted {p.staysClosed.length === 1 ? 'database' : 'databases'} ({nameList(p.staysClosed)}){' '}
          {p.staysClosed.length === 1 ? 'stays' : 'stay'} closed.
        </p>
      )}
      <p className="text-label text-muted">The people added here stay on the list, so restricting it again brings back the same people.</p>
      <div className="flex justify-end gap-2 max-md:flex-col-reverse">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" onClick={onConfirm} disabled={busy}>
          {busy ? 'Opening…' : 'Open to everyone'}
        </Button>
      </div>
    </div>
  );
}
