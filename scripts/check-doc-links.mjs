#!/usr/bin/env node
/** Checks that every relative markdown link in the repo points to an existing file. */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, normalize } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', '.turbo', '.claude']);
const mdFiles = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (entry.endsWith('.md')) mdFiles.push(p);
  }
}
walk('.');

// Site-absolute links (/foo/bar/) are Starlight route URLs, not repo file paths:
// extensionless, slug-based, resolved by the docs site. Validate them against the
// Starlight content root instead of the filesystem-relative path.
const DOCS_ROOT = 'apps/docs/src/content/docs';
// Routes generated at build time (not backed by a content file). starlight-openapi
// renders the whole OpenAPI reference under `api/reference/*` from openapi.json
// (see apps/docs/astro.config.mjs), so those pages have no .md source.
const GENERATED_ROUTE_PREFIXES = ['api/reference'];
function docsRouteExists(link) {
  const slug = link.replace(/^\/+|\/+$/g, '');
  if (slug === '') return true; // site root → index
  if (GENERATED_ROUTE_PREFIXES.some((p) => slug === p || slug.startsWith(`${p}/`))) return true;
  return [
    `${DOCS_ROOT}/${slug}.md`,
    `${DOCS_ROOT}/${slug}.mdx`,
    `${DOCS_ROOT}/${slug}/index.md`,
    `${DOCS_ROOT}/${slug}/index.mdx`,
  ].some(existsSync);
}

let broken = 0;
const linkRe = /\]\(([^)#\s]+)(?:#[^)]*)?\)/g;
for (const file of mdFiles) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(linkRe)) {
    const link = match[1];
    if (/^(https?:|mailto:)/.test(link)) continue;
    const ok = link.startsWith('/')
      ? docsRouteExists(link)
      : existsSync(normalize(join(dirname(file), link)));
    if (!ok) {
      console.error(`BROKEN: ${file} -> ${link}`);
      broken++;
    }
  }
}

console.log(`${mdFiles.length} markdown files checked, ${broken} broken links`);
process.exit(broken ? 1 : 0);
