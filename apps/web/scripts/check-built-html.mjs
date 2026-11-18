// Assert against what the BUILD actually emitted and SERVES, not against the source. Runs after `next build`
// (package.json "build"), so it fails in CI and in the Docker image build alike.
//
// Ticket #855 — the first version of the Figtree preload passed a source-text guard and shipped as
// `<link rel="preload" as="font">` with NO href (the static import is a URL string under this repo's `next build`, and
// the code read `.src` off it). A test that reads the repository cannot see that; the served HTML can.
//
// Ticket #1122 — one web image is deployed to staging AND production (build once, deploy many), so the public origin
// must come from the container's runtime WEB_URL, never from the build. Every image used to be built with
// WEB_URL=https://staging.storyos.dev, and production's link previews pointed at staging. Two checks guard that:
//   1. no build output contains a deployment origin (or the build-time WEB_URL, if one was set);
//   2. the built server, started with a WEB_URL the build never saw, serves og:image on THAT origin.
// /login is fetched from the running server because it is no longer prerendered to a file.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const fail = (msg) => {
  console.error(`check-built-html: ${msg}`);
  process.exit(1);
};
const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        // node_modules: third-party code; cache: Next's own fetch/image cache, not shipped output.
        if (n === 'node_modules' || n === 'cache') return [];
        return statSync(p).isDirectory() ? walk(p) : [p];
      })
    : [];

// ── 1. No deployment origin is baked into the build output ──────────────────────────────────────────────────────────
const forbidden = new Set(['staging.storyos.dev', 'app.storyos.dev']);
const buildWebUrl = process.env.WEB_URL?.trim();
if (buildWebUrl) {
  try {
    const { host, hostname } = new URL(buildWebUrl);
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') forbidden.add(host);
  } catch {
    fail(`WEB_URL is set for the build but is not a URL: ${JSON.stringify(buildWebUrl)}`);
  }
}
const textual = /\.(html|rsc|meta|body|json|js|mjs|cjs|css|txt|webmanifest|xml)$/; // not .map: source maps carry source comments, which name origins harmlessly
const outputs = [
  join(root, '.next/server'),
  join(root, '.next/static'),
  join(root, '.next/standalone/apps/web/.next'),
]
  .flatMap(walk)
  .filter((f) => textual.test(f));
if (outputs.length === 0) fail('found no build output under .next/ — did `next build` run?');
for (const f of outputs) {
  const text = readFileSync(f, 'utf8');
  for (const host of forbidden) {
    if (text.includes(host)) {
      fail(
        `${f.slice(root.length)} contains the origin "${host}". The web image is deployed to more than one origin, so the ` +
          'public origin must be read from the runtime WEB_URL, not baked in at build time (ticket #1122).',
      );
    }
  }
}

// ── 2. Start the built server with a runtime WEB_URL and read what it serves ───────────────────────────────────────
const server = join(root, '.next/standalone/apps/web/server.js');
if (!existsSync(server))
  fail(`no standalone server at ${server} (next.config.mjs output: 'standalone')`);

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const RUNTIME_ORIGIN = 'https://runtime-origin.example';
const port = await freePort();
const child = spawn(process.execPath, [server], {
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    WEB_URL: RUNTIME_ORIGIN,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d));
child.stderr.on('data', (d) => (serverLog += d));
process.on('exit', () => child.kill('SIGTERM'));
const failWithLog = (msg) => fail(`${msg}\n--- server output ---\n${serverLog}`);

let html;
let linkHeader = '';
for (let i = 0; i < 150 && html === undefined; i++) {
  if (child.exitCode !== null) failWithLog(`the built server exited with code ${child.exitCode}`);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/login`);
  } catch {
    await new Promise((r) => setTimeout(r, 200));
    continue;
  }
  if (res.status !== 200) failWithLog(`GET /login answered ${res.status}`);
  linkHeader = res.headers.get('link') ?? '';
  html = await res.text();
}
if (html === undefined) failWithLog('the built server did not answer GET /login within 30s');

const metaContent = (attr, name) =>
  new RegExp(`<meta\\b[^>]*\\b${attr}="${name}"[^>]*\\bcontent="([^"]+)"`).exec(html)?.[1];
for (const [attr, name] of [
  ['property', 'og:image'],
  ['name', 'twitter:image'],
]) {
  const got = metaContent(attr, name);
  if (got !== `${RUNTIME_ORIGIN}/og.png`) {
    fail(
      `started with WEB_URL=${RUNTIME_ORIGIN}, the server's /login ${name} is ${JSON.stringify(got)}; expected ` +
        `${RUNTIME_ORIGIN}/og.png. The origin was fixed at build time instead of read at runtime (ticket #1122).`,
    );
  }
}

// ── 3. #855: exactly one font preload, for the same hashed Figtree file the stylesheet fetches ─────────────────────
// A request-time render (#1122) hands React's preload() to Next as an HTTP `Link: <…>; rel=preload` header; a
// prerendered page carries it as a <link> tag. A browser treats both alike, so count both: exactly one, in total.
const fromHtml = [...html.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)]
  .map((m) => m[0])
  .filter((tag) => /\bas="font"/.test(tag));
const fromHeader = linkHeader
  .split(/,(?=\s*<)/)
  .map((v) => v.trim())
  .filter((v) => /;\s*rel="?preload"?/.test(v) && /;\s*as="?font"?/.test(v));
const preloads = [...fromHtml, ...fromHeader];
if (preloads.length !== 1) {
  fail(
    `expected exactly one font preload for /login (Link header or HTML), found ${preloads.length}: ${preloads.join(' | ')}`,
  );
}
const href = (/\bhref="([^"]+)"/.exec(preloads[0]) ?? /^<([^>]+)>/.exec(preloads[0]))?.[1];
if (!href) fail(`the font preload has no href: ${preloads[0]}`);
if (!/figtree-latin\.[^/]*\.woff2$/.test(href))
  fail(`the font preload is not Figtree Latin: ${href}`);
if (!/\btype="?font\/woff2"?/.test(preloads[0]))
  fail(`the font preload has no type="font/woff2": ${preloads[0]}`);
if (!/\bcrossorigin\b/i.test(preloads[0]))
  fail(`the font preload has no crossorigin (the font would be fetched twice): ${preloads[0]}`);

// The same hashed file must be the one the stylesheet fetches, or the preload is a second request.
// (Stylesheet location differs by bundler: static/css or static/chunks, so walk .next/static.)
const cssFiles = walk(join(root, '.next/static')).filter((f) => f.endsWith('.css'));
const referenced = cssFiles.some((f) => readFileSync(f, 'utf8').includes(href.split('/').pop()));
if (!referenced)
  fail(
    `no built stylesheet references ${href.split('/').pop()}; the preload would not match the @font-face file`,
  );

console.log(
  `check-built-html: ok (og:image from runtime WEB_URL ${RUNTIME_ORIGIN}; font preload ${href})`,
);
process.exit(0);
