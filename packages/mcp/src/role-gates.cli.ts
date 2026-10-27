/** `pnpm --filter @storyos/mcp role-gates:generate` — rewrites role-gates.generated.ts (run by `pnpm sdk:generate`). */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeToolMinRoles, renderGeneratedFile } from './role-gates.js';

const here = import.meta.dirname;
const openapi = JSON.parse(readFileSync(join(here, '..', '..', '..', 'docs', 'api', 'openapi.json'), 'utf8'));
const roles = computeToolMinRoles(readFileSync(join(here, 'tools.ts'), 'utf8'), openapi);
writeFileSync(join(here, 'role-gates.generated.ts'), renderGeneratedFile(roles));
console.log(`role-gates.generated.ts: ${Object.keys(roles).length} tools need a role above guest`);
