import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Ticket #1377 - "is this write part of an import run?", carried on the ambient context so the event emitter can stamp it
 * (`DomainEvent.importRun`) without every write path having to remember it. The one consumer that matters is the outward one: a
 * Slack channel subscription must not post 5,000 "created" messages because someone imported a project (and must not post a
 * "status changed" for every issue a first or full read touched).
 *
 * `full` is the safe default and what an importer is until it says otherwise: a full read, a first import, or any importer that has
 * not declared a mode. `incremental` is a scheduled run that read only what the source changed since its cursor, so a status change it
 * carries is a real, recent one, and the one thing people want posted. The Linear sync sets it; nothing else does.
 *
 * Leaf module with no imports of ours, like `credential-context.ts`.
 */
export type ImportRunMode = 'full' | 'incremental';

const store = new AsyncLocalStorage<{ mode: ImportRunMode }>();

/** Run `fn` as an import run. An importer already inside one keeps its mode (an inner upsert never downgrades the run it is part of). */
export function runAsImportRun<T>(fn: () => T, mode: ImportRunMode = 'full'): T {
  return store.getStore() ? fn() : store.run({ mode }, fn);
}

/** Set the mode of the run we are inside, once the importer has decided it (the plan is made after the run has started). No-op outside one. */
export function setImportRunMode(mode: ImportRunMode): void {
  const s = store.getStore();
  if (s) s.mode = mode;
}

/** The mode of the import run this code is part of, or null for an ordinary write. */
export function currentImportRun(): ImportRunMode | null {
  return store.getStore()?.mode ?? null;
}
