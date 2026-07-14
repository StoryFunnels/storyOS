// Copies the committed OpenAPI spec (single source of truth in docs/api/openapi.json)
// into this app so the build is self-contained and Vite-resolvable.
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../../docs/api/openapi.json');
const dest = resolve(here, '../openapi.json');

if (!existsSync(src)) {
  console.error(`[sync-openapi] source spec not found at ${src}`);
  process.exit(1);
}

copyFileSync(src, dest);
console.log(`[sync-openapi] copied ${src} -> ${dest}`);
