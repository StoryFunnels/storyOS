/**
 * Removing the profile photo (Settings > Profile, parity row Account #3, ticket #1190).
 *
 * The table promised "gains a confirm and a toast". The confirm shipped; the toast did not, and a failed removal looked like a
 * success because the response was never read. The logic lives here, taking the request and the notifier as arguments, so a test can
 * drive a FAILED response and assert the person is told, rather than a source check that only proves some text is present.
 */
export interface PhotoNotifier {
  success: (message: string) => void;
  error: (message: string) => void;
}

export const PHOTO_REMOVED = 'Photo removed';
export const PHOTO_NOT_REMOVED = 'Could not remove the photo';

/** Runs `request` (the DELETE). A non-ok response, or a request that throws, shows the error and returns false; only a real success shows the success and returns true. */
export async function removeProfilePhoto(request: () => Promise<{ ok: boolean }>, notify: PhotoNotifier): Promise<boolean> {
  try {
    const res = await request();
    if (!res.ok) throw new Error('photo removal refused');
    notify.success(PHOTO_REMOVED);
    return true;
  } catch {
    notify.error(PHOTO_NOT_REMOVED);
    return false;
  }
}
