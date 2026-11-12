import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastSuccess = vi.fn();
const toastError = vi.fn();
const apiDelete = vi.fn();
const apiPost = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));
vi.mock('@/lib/api', () => ({ api: { DELETE: (...a: unknown[]) => apiDelete(...a), POST: (...a: unknown[]) => apiPost(...a) } }));

import { restoreFailedMessage, trashRecord, trashedMessage } from './trash-record';
import { DESTRUCTIVE_TOAST_MS, clearUndo, runLastUndo, undoDepth } from './undo';

const args = { ws: 'w', db: 'd', rec: 'r1', title: 'Fix login' };

beforeEach(() => {
  vi.clearAllMocks();
  clearUndo();
});

describe('#1275 single-record delete: trash, then an Undo that is real', () => {
  it('names the record, lasts 10 seconds, and carries an Undo action', async () => {
    apiDelete.mockResolvedValue({ error: undefined });
    await trashRecord(args);
    expect(DESTRUCTIVE_TOAST_MS).toBe(10_000);
    const [msg, opts] = toastSuccess.mock.calls[0]!;
    expect(msg).toBe('Deleted "Fix login"');
    expect(opts.duration).toBe(10_000);
    expect(opts.action.label).toBe('Undo');
  });

  it('Undo calls the real restore endpoint for that record and confirms', async () => {
    apiDelete.mockResolvedValue({ error: undefined });
    apiPost.mockResolvedValue({ error: undefined });
    const onChanged = vi.fn();
    await trashRecord({ ...args, onChanged });
    onChanged.mockClear();
    await toastSuccess.mock.calls[0]![1].action.onClick();
    expect(apiPost).toHaveBeenCalledWith('/api/v1/workspaces/{ws}/databases/{db}/records/{rec}/restore', {
      params: { path: { ws: 'w', db: 'd', rec: 'r1' } },
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenLastCalledWith('Restored "Fix login"');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('a failed Undo says the record is still in the trash, never "restored"', async () => {
    apiDelete.mockResolvedValue({ error: undefined });
    apiPost.mockResolvedValue({ error: { message: 'nope' } });
    await trashRecord(args);
    await toastSuccess.mock.calls[0]![1].action.onClick();
    expect(toastError).toHaveBeenCalledWith('Could not restore "Fix login". It is still in the trash.');
    expect(toastSuccess).toHaveBeenCalledTimes(1); // only the "Deleted" toast, no "Restored"
  });

  it('a failed DELETE announces nothing and pushes no undo entry', async () => {
    apiDelete.mockResolvedValue({ error: { message: 'forbidden' } });
    await expect(trashRecord(args)).rejects.toBeTruthy();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(undoDepth()).toBe(0);
  });

  it('the Cmd-Z route restores through the same endpoint', async () => {
    apiDelete.mockResolvedValue({ error: undefined });
    apiPost.mockResolvedValue({ error: undefined });
    await trashRecord(args);
    expect(undoDepth()).toBe(1);
    await runLastUndo();
    expect(apiPost).toHaveBeenCalledTimes(1);
  });

  it('never invents a title, and a personal lens says it deleted for everyone', () => {
    expect(trashedMessage('  ')).toBe('Deleted this untitled record');
    expect(trashedMessage(null)).toBe('Deleted this untitled record');
    expect(restoreFailedMessage('')).toBe('Could not restore The record. It is still in the trash.');
    expect(trashedMessage('Fix login', true)).toBe('Deleted "Fix login" for everyone in the workspace, not just this view');
    expect(trashedMessage('Fix login', false)).not.toMatch(/everyone/);
  });
});

/**
 * The entry points are found by scanning the source for the delete endpoint, not
 * from a hand list: a new caller that deletes one record without the shared action
 * fails here, which is how the record panel's Undo-less delete went unnoticed.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
  }
  return out;
}
const SRC = join(__dirname, '..');
const files = walk(SRC);
const read = (p: string) => readFileSync(p, 'utf8');

describe('#1275 every single-record delete entry point routes through the shared action', () => {
  const DELETE_ENDPOINT = /DELETE\(\s*'\/api\/v1\/workspaces\/\{ws\}\/databases\/\{db\}\/records\/\{rec\}'/;

  it('only lib/trash-record.ts calls the single-record DELETE endpoint', () => {
    const callers = files.filter((f) => DELETE_ENDPOINT.test(read(f))).map((f) => f.slice(SRC.length + 1));
    expect(callers).toEqual(['lib/trash-record.ts']);
  });

  it('every consumer of that shared module announces through it (table row hook, record panel)', () => {
    const users = files
      .filter((f) => /from '@\/lib\/trash-record'/.test(read(f)))
      .map((f) => f.slice(SRC.length + 1))
      .sort();
    expect(users).toEqual(['components/entity/record-chrome.tsx', 'components/table-view/use-table-data.ts']);
    for (const u of users) expect(read(join(SRC, u))).toMatch(/announceTrashed\(/);
  });

  it('the table row trash button hands the title and the personal-lens flag to the shared mutation', () => {
    const tv = read(join(SRC, 'components/table-view/table-view.tsx'));
    expect(tv).toMatch(/deleteRecord\.mutate\(\{ id: row\.id, title: row\.title, personalLens \}\)/);
    expect(tv).not.toMatch(/window\.confirm|confirm\(\{[^}]*Delete/);
    expect(read(join(SRC, 'app/w/[ws]/d/[db]/page.tsx'))).toMatch(/personalLens=\{Boolean\(activeView\?\.ownerUserId\)\}/);
  });

  it('bulk delete keeps its confirm and its count-naming Undo (not routed through the single action)', () => {
    const bar = read(join(SRC, 'components/table-view/batch-bar.tsx'));
    expect(bar).toMatch(/selected\.length > 25 &&\s*!\(await confirm\(/);
    expect(bar).toMatch(/moved to trash`/);
    expect(bar).toMatch(/batch-restore/);
    expect(bar).not.toMatch(/trash-record/);
  });
});
