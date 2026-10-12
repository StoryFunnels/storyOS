// Ticket #855 — assert against what the BUILD actually emitted, not against the source.
//
// The first version of the Figtree preload passed a source-text guard and shipped as
// `<link rel="preload" as="font">` with NO href (the static import is a URL string under this
// repo's `next build`, and the code read `.src` off it). A test that reads the repository cannot
// see that; the prerendered HTML can. Runs after `next build` (package.json "build") so a build
// that drops or breaks the hint fails here, in CI and in the Docker image build alike.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const html = readFileSync(join(root, '.next/server/app/login.html'), 'utf8');

const preloads = [...html.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)].map((m) => m[0]).filter((tag) => /\bas="font"/.test(tag));
const fail = (msg) => {
  console.error(`check-built-html: ${msg}`);
  process.exit(1);
};

if (preloads.length !== 1) fail(`expected exactly one font preload in the built /login HTML, found ${preloads.length}: ${preloads.join(' ')}`);
const href = /\bhref="([^"]+)"/.exec(preloads[0])?.[1];
if (!href) fail(`the font preload has no href: ${preloads[0]}`);
if (!/figtree-latin\.[^/]*\.woff2$/.test(href)) fail(`the font preload is not Figtree Latin: ${href}`);
if (!/\btype="font\/woff2"/.test(preloads[0])) fail(`the font preload has no type="font/woff2": ${preloads[0]}`);
if (!/\bcrossorigin\b/i.test(preloads[0])) fail(`the font preload has no crossorigin (the font would be fetched twice): ${preloads[0]}`);

// The same hashed file must be the one the stylesheet fetches, or the preload is a second request.
// (Stylesheet location differs by bundler: static/css or static/chunks, so walk .next/static.)
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const cssFiles = walk(join(root, '.next/static')).filter((f) => f.endsWith('.css'));
const referenced = cssFiles.some((f) => readFileSync(f, 'utf8').includes(href.split('/').pop()));
if (!referenced) fail(`no built stylesheet references ${href.split('/').pop()}; the preload would not match the @font-face file`);

console.log(`check-built-html: ok (font preload ${href})`);
