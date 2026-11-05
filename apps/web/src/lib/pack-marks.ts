/**
 * #1176 — the two marks on a pack card ("Agent", "Notifies") are plain labels, and each says what it stands for in a tooltip built
 * from the pack's OWN items, so a pack that has no agent never claims one and the names are never hard-coded per pack.
 *
 * Pure, so each sentence is a test. The manifest arrives as `unknown`; everything is optional.
 */
export interface MarkManifest {
  agents?: Array<{ name?: string }> | null;
  automations?: Array<{ name?: string; actions?: Array<{ type?: string }> | null }> | null;
}

export type PackMarkKind = 'agent' | 'notifies';

/**
 * The same test the API uses to light the "Notifies" mark: an automation with a `notify_user` action
 * (apps/api/src/packs/packs.controller.ts, `registry()` -> `marks.notifies`). Mirrors it; if one changes, change both.
 */
export function notifiesPeople(automation: { actions?: Array<{ type?: string }> | null }): boolean {
  return (automation.actions ?? []).some((a) => a.type === 'notify_user');
}

/** The names the mark stands for, read from the pack's own items. [] while the manifest is not loaded or names nothing. */
export function markNames(manifest: MarkManifest | null | undefined, kind: PackMarkKind): string[] {
  const names =
    kind === 'agent'
      ? (manifest?.agents ?? []).map((a) => a.name)
      : (manifest?.automations ?? []).filter(notifiesPeople).map((a) => a.name);
  return names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
}

/**
 * "Comes with an agent: Triage" / "Comes with an automation that tells people: Tell the assignee". With several, the count leads
 * ("Comes with 2 agents: A, B"). With no names to give (manifest still loading), the sentence is the same minus the colon part:
 * it never invents a name.
 */
export function markTip(kind: PackMarkKind, names: string[]): string {
  const one = kind === 'agent' ? 'an agent' : 'an automation that tells people';
  const many = (n: number) => (kind === 'agent' ? `${n} agents` : `${n} automations that tell people`);
  if (names.length === 0) return `Comes with ${one}`;
  return `Comes with ${names.length === 1 ? one : many(names.length)}: ${names.join(', ')}`;
}
