'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { DialogClose, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AccessMain, OpenStep, RestrictStep } from '@/components/access/manage-access';
import { useAccessMutations, useAccessPeopleAndGrants } from '@/lib/access-queries';
import type { AccessScope } from '@/lib/access-queries';
import { ROLE_WORDS, restrictPreview } from '@/lib/access-model';
import type { AccessCard, DatabaseTarget, GrantRole, Person, PersonRow, SpaceTarget, Target } from '@/lib/access-model';
import { useDatabases, useSpaces } from '@/lib/queries';

type Step = { kind: 'main' } | { kind: 'restrict' } | { kind: 'open' };

/**
 * #924 — Share / Manage access (ADR-0018 v1, design by Dara): one dialog for a space and for a database. Admin only
 * (the entry points ask `canManageAccess`; the API refuses anyone else). It saves as it happens, except the two steps
 * with consequences, which confirm first: Everyone → Restricted (who loses access, with a Keep tick each) and
 * Restricted → Everyone (who gains what).
 *
 * Phone: a bottom sheet with a grabber (the Dialog is re-skinned below 768px, the role menu is already a sheet).
 */
export function ManageAccessDialog({ ws, scope }: { ws: string; scope: AccessScope }) {
  // "Manage <space>'s access →" reopens this dialog on the space without closing it.
  const [active, setActive] = useState<AccessScope>(scope);
  const [step, setStep] = useState<Step>({ kind: 'main' });
  const [keep, setKeep] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const spaces = useSpaces(ws);
  const databases = useDatabases(ws);
  const { people, grants, isPending, isError } = useAccessPeopleAndGrants(ws);
  const { grant, revoke, setRestricted } = useAccessMutations(ws, active);

  const target = buildTarget(active, spaces.data, databases.data);
  const restrictedDatabaseNames =
    target?.kind === 'space'
      ? (databases.data ?? []).filter((d) => d.spaceId === target.id && d.restricted && !d.isSystem).map((d) => d.name)
      : [];

  const sheet =
    'max-w-lg max-h-[85dvh] overflow-y-auto max-md:top-auto max-md:bottom-0 max-md:left-0 max-md:max-h-[92dvh] max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none max-md:p-4 max-md:pt-7 max-md:pb-[max(1rem,env(safe-area-inset-bottom))]';

  if (!target || isPending || isError) {
    return (
      <DialogContent title="Access" className={sheet}>
        <p role={isError ? 'alert' : 'status'} className={isError ? 'text-body text-error' : 'text-body text-muted'}>
          {isError ? 'Could not load who has access. Try again in a moment.' : 'Loading…'}
        </p>
      </DialogContent>
    );
  }

  const back = () => {
    setStep({ kind: 'main' });
    setKeep(new Set());
  };
  const pickCard = (key: AccessCard['key']) => {
    setKeep(new Set());
    setStep({ kind: key === 'restricted' ? 'restrict' : 'open' });
  };
  const toggleKeep = (id: string) =>
    setKeep((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirmRestrict = async () => {
    setBusy(true);
    try {
      const lose = restrictPreview(target, people, grants);
      // Grants FIRST, then the flag: the other order leaves a window where the people to keep are locked out.
      await Promise.all(lose.filter((l) => keep.has(l.person.userId)).map((l) => grant.mutateAsync({ userId: l.person.userId, role: l.keepAs })));
      await setRestricted.mutateAsync(true);
      const removed = lose.filter((l) => !keep.has(l.person.userId)).length;
      toast.success(
        removed > 0
          ? `“${target.name}” is restricted — ${removed} ${removed === 1 ? 'person' : 'people'} no longer see it`
          : `“${target.name}” is restricted`,
      );
      back();
    } catch {
      // each mutation already said what failed; the step stays open so nothing is half-hidden from the admin
    } finally {
      setBusy(false);
    }
  };

  const confirmOpen = async () => {
    setBusy(true);
    try {
      await setRestricted.mutateAsync(false);
      toast.success(`“${target.name}” is open to everyone`);
      back();
    } catch {
      // see above
    } finally {
      setBusy(false);
    }
  };

  const changeRole = (row: PersonRow, role: GrantRole) =>
    grant.mutate(
      { userId: row.person.userId, role },
      { onSuccess: () => toast.success(`${row.person.name} is now ${ROLE_WORDS[role].label} on “${target.name}”`) },
    );

  const removeAccess = (row: PersonRow) => {
    if (!row.grant) return;
    const { userId } = row.person;
    const role = row.role!;
    revoke.mutate(row.grant.id, {
      onSuccess: () =>
        toast(`${row.person.name} no longer has access to “${target.name}”`, {
          action: { label: 'Undo', onClick: () => grant.mutate({ userId, role }) },
        }),
    });
  };

  const addPerson = (person: Person, role: GrantRole) =>
    grant.mutate(
      { userId: person.userId, role },
      { onSuccess: () => toast.success(`${person.name} can now see “${target.name}” as ${ROLE_WORDS[role].label}`) },
    );

  const subtitle =
    target.kind === 'space'
      ? 'Space · only admins can change this'
      : `Database in ${target.space.name} · only admins can change this`;

  return (
    <DialogContent title={`Access to “${target.name}”`} className={sheet}>
      <div aria-hidden className="absolute left-1/2 top-2.5 h-1 w-9 -translate-x-1/2 rounded-full bg-border-strong md:hidden" />
      <p className="-mt-2 mb-4 text-label text-muted">{subtitle}</p>

      {step.kind === 'main' && (
        <>
          <AccessMain
            target={target}
            people={people}
            grants={grants}
            onPickCard={pickCard}
            onRole={changeRole}
            onRemove={removeAccess}
            onAdd={addPerson}
            onOpenSpace={target.kind === 'database' ? () => setActive({ space_id: target.space.id }) : undefined}
          />
          <div className="mt-4 flex justify-end">
            <DialogClose asChild>
              <Button type="button" className="max-md:w-full">
                Done
              </Button>
            </DialogClose>
          </div>
        </>
      )}

      {step.kind === 'restrict' && (
        <>
          <h3 className="mb-2 text-prose font-semibold text-ink">Restrict “{target.name}”?</h3>
          <RestrictStep
            target={target}
            people={people}
            grants={grants}
            keep={keep}
            onToggle={toggleKeep}
            busy={busy}
            onCancel={back}
            onConfirm={() => void confirmRestrict()}
          />
        </>
      )}

      {step.kind === 'open' && (
        <>
          <h3 className="mb-2 text-prose font-semibold text-ink">Open “{target.name}” to everyone?</h3>
          <OpenStep
            target={target}
            people={people}
            grants={grants}
            restrictedDatabaseNames={restrictedDatabaseNames}
            busy={busy}
            onCancel={back}
            onConfirm={() => void confirmOpen()}
          />
        </>
      )}
    </DialogContent>
  );
}

function buildTarget(
  scope: AccessScope,
  spaces: Array<{ id: string; name: string; restricted?: boolean }> | undefined,
  databases: Array<{ id: string; name: string; spaceId: string; restricted?: boolean; isSystem?: boolean }> | undefined,
): Target | null {
  if ('space_id' in scope) {
    const s = spaces?.find((x) => x.id === scope.space_id);
    return s ? ({ kind: 'space', id: s.id, name: s.name, restricted: s.restricted === true } satisfies SpaceTarget) : null;
  }
  const d = databases?.find((x) => x.id === scope.database_id);
  const space = d ? spaces?.find((x) => x.id === d.spaceId) : undefined;
  if (!d || !space) return null;
  return {
    kind: 'database',
    id: d.id,
    name: d.name,
    restricted: d.restricted === true,
    isSystem: d.isSystem === true,
    space: { id: space.id, name: space.name, restricted: space.restricted === true },
  } satisfies DatabaseTarget;
}
