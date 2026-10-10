/**
 * The URL of a statically imported asset (ticket #855).
 *
 * What `import x from './file.woff2'` evaluates to depends on the bundler: some return a plain URL
 * string, others `{ src, ... }` like Next's image imports. This repo's `next build` returns the
 * STRING; a first version of the font preload read `.src` off it, got `undefined`, and React dropped
 * the `href` attribute — a preload that silently preloaded nothing, which typecheck could not catch
 * because the declaration claimed the other shape. Accept both shapes, and THROW on anything else so
 * the next bundler change fails the build instead of shipping a hint with no URL.
 */
export function assetUrl(asset: unknown): string {
  if (typeof asset === 'string' && asset.length > 0) return asset;
  if (typeof asset === 'object' && asset !== null) {
    const src = (asset as { src?: unknown }).src;
    if (typeof src === 'string' && src.length > 0) return src;
  }
  throw new Error(`assetUrl: expected a URL string or { src: string }, got ${typeof asset}`);
}
