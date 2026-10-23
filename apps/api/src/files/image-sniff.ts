/**
 * #1031 — what an uploaded editor image really is, from its bytes. The client-supplied mime used to be trusted
 * (anything starting `image/`, so `image/svg+xml`), and `GET /files/:id` replayed it on the app's own origin: an SVG
 * with a script in it ran as the victim. Only raster types a browser cannot execute are allowed; SVG is not one.
 */
export const SAFE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type SafeImageMime = (typeof SAFE_IMAGE_MIMES)[number];

export function sniffImageMime(data: Buffer): SafeImageMime | null {
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length > 6 && (data.subarray(0, 6).toString('ascii') === 'GIF87a' || data.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  if (data.length > 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

export const isSafeImageMime = (mime: string): mime is SafeImageMime => (SAFE_IMAGE_MIMES as readonly string[]).includes(mime);
