import { describe, expect, it } from 'vitest';
import { PHOTO_NOT_REMOVED, PHOTO_REMOVED, removeProfilePhoto } from './remove-photo';

function notifier() {
  const calls: string[] = [];
  return { calls, notify: { success: (m: string) => calls.push(`success:${m}`), error: (m: string) => calls.push(`error:${m}`) } };
}

describe('removing the profile photo (ticket #1190)', () => {
  it('a successful removal shows the success toast and reports true', async () => {
    const { calls, notify } = notifier();
    expect(await removeProfilePhoto(async () => ({ ok: true }), notify)).toBe(true);
    expect(calls).toEqual([`success:${PHOTO_REMOVED}`]);
  });

  it('a failed response (500) shows the error toast, never the success one, and reports false', async () => {
    const { calls, notify } = notifier();
    expect(await removeProfilePhoto(async () => ({ ok: false }), notify)).toBe(false);
    expect(calls).toEqual([`error:${PHOTO_NOT_REMOVED}`]);
  });

  it('a request that throws (network down) shows the error toast and reports false', async () => {
    const { calls, notify } = notifier();
    const down = async (): Promise<{ ok: boolean }> => { throw new Error('offline'); };
    expect(await removeProfilePhoto(down, notify)).toBe(false);
    expect(calls).toEqual([`error:${PHOTO_NOT_REMOVED}`]);
  });
});
