#!/usr/bin/env node
/**
 * The Apache-2.0 / AGPL boundary check (ADR-0021 section 9, question 9; ticket #1134).
 *
 * `packages/runner` is Apache-2.0 inside an AGPL monorepo. Apache code may be used by AGPL code; AGPL code may NOT be pulled into an
 * Apache package without making the combination AGPL. So the Runner must not depend on, import, or copy from any AGPL workspace
 * package, and the way that goes wrong is quiet: a `workspace:*` line, one `import ... from '@storyos/schemas'`, or a relative path
 * that climbs out of the package. Nothing fails to compile. This script is the thing that fails.
 *
 *   node scripts/check-runner-license-boundary.mjs            # check the real package; exit 1 on any violation
 *   node scripts/check-runner-license-boundary.mjs --root DIR # check another checkout (used by the tests)
 *
 * What it checks:
 *  1. The Runner's own `package.json` says "license": "Apache-2.0" and a LICENSE file with the Apache 2.0 text sits beside it.
 *  2. No dependency (dependencies, devDependencies, peerDependencies, optionalDependencies) names an AGPL workspace package, and no
 *     `workspace:`/`link:`/`file:` spec points anywhere unless it names a workspace package that is itself permissive.
 *  3. No source file (src, test) imports or requires an AGPL workspace package, and no relative import resolves outside the package.
 *  4. Production dependencies, and everything they bring, carry a PERMISSIVE licence only (MIT, ISC, BSD, Apache-2.0, 0BSD): the
 *     repo-wide list admits LGPL/GPL/MPL for an AGPL product, which an embeddable Apache package must not inherit.
 *
 * Like the collision check (CLAUDE.md rule 3): "cannot tell" FAILS. A workspace package with no licence, a production dependency that
 * cannot be resolved, a licence that is not in the list: each is a violation, because unresolvable must never read as "no problem".
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PERMISSIVE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']);
const RUNNER_NAME = '@storyos/runner';
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const SOURCE_DIRS = ['src', 'test'];
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Every workspace package (apps/* and packages/*) except the Runner itself, with the licence it declares (or null). */
export function workspacePackages(repoRoot) {
  const out = [];
  for (const group of ['apps', 'packages']) {
    const base = join(repoRoot, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const file = join(base, name, 'package.json');
      if (!existsSync(file)) continue;
      const pkg = readJson(file);
      if (pkg.name === RUNNER_NAME) continue;
      out.push({ name: pkg.name, dir: join(base, name), license: typeof pkg.license === 'string' ? pkg.license : null, pkg });
    }
  }
  return out;
}

/** Permissive workspace packages are allowed to be depended on; everything else (AGPL, unknown, missing) is forbidden. */
function isPermissive(license) {
  return license !== null && PERMISSIVE.has(license);
}

/** Specifiers in a source file: static imports/exports, dynamic imports, requires. A comment or a string that merely mentions a path is not one. */
export function importSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+)from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bcreateRequire\b[^;]*?\.resolve\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const p of patterns) for (const m of source.matchAll(p)) specs.add(m[1]);
  return [...specs];
}

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SOURCE_EXT.test(name)) yield full;
  }
}

function licenseOfInstalled(pkgJsonPath) {
  const pkg = readJson(pkgJsonPath);
  let license = pkg.license;
  if (license && typeof license === 'object') license = license.type;
  return { name: pkg.name, license: typeof license === 'string' ? license : null, pkg };
}

/** An SPDX expression like "(MIT OR Apache-2.0)" is permissive only if EVERY alternative we would have to accept is, or any one of an OR is. */
export function expressionIsPermissive(license) {
  if (license === null) return false;
  const text = license.replace(/[()]/g, ' ').trim();
  if (/\sOR\s/.test(text)) return text.split(/\sOR\s/).some((part) => expressionIsPermissive(part.trim()));
  if (/\sAND\s/.test(text)) return text.split(/\sAND\s/).every((part) => expressionIsPermissive(part.trim()));
  return PERMISSIVE.has(text);
}

/** The whole production dependency closure of the Runner, each with its declared licence. */
function productionClosure(runnerDir, runnerPkg, byName) {
  const seen = new Map();
  const problems = [];
  const visit = (fromPkgJson, deps) => {
    const req = createRequire(fromPkgJson);
    for (const dep of Object.keys(deps ?? {})) {
      let resolved;
      if (byName.has(dep)) {
        // a workspace package resolves to its own directory, whatever the install layout
        resolved = join(byName.get(dep).dir, 'package.json');
      } else
      try {
        resolved = req.resolve(`${dep}/package.json`);
      } catch {
        // pnpm exposes package.json through the symlinked directory even when `exports` hides it
        const guess = join(dirname(fromPkgJson), 'node_modules', dep, 'package.json');
        resolved = existsSync(guess) ? guess : null;
      }
      if (!resolved) {
        problems.push(`production dependency "${dep}" cannot be resolved, so its licence cannot be checked (run pnpm install). Unresolvable must never read as fine.`);
        continue;
      }
      if (seen.has(resolved)) continue;
      const info = licenseOfInstalled(resolved);
      seen.set(resolved, info);
      visit(resolved, { ...info.pkg.dependencies, ...info.pkg.optionalDependencies });
    }
  };
  visit(join(runnerDir, 'package.json'), runnerPkg.dependencies);
  return { closure: [...seen.values()], problems };
}

/**
 * Returns a list of human-readable violations (empty = the boundary holds).
 * `repoRoot` is a checkout; the Runner is `<repoRoot>/packages/runner`.
 */
export function checkBoundary({ repoRoot }) {
  const violations = [];
  const runnerDir = join(repoRoot, 'packages', 'runner');
  const pkgFile = join(runnerDir, 'package.json');
  if (!existsSync(pkgFile)) return [`${relative(repoRoot, pkgFile)} does not exist: nothing to check, which is not the same as passing.`];
  const pkg = readJson(pkgFile);

  // 1. the Runner's own licence
  if (pkg.license !== 'Apache-2.0') violations.push(`packages/runner/package.json "license" must be "Apache-2.0" (it is ${JSON.stringify(pkg.license ?? null)}).`);
  const licenseFile = join(runnerDir, 'LICENSE');
  if (!existsSync(licenseFile)) violations.push('packages/runner/LICENSE is missing.');
  else {
    const text = readFileSync(licenseFile, 'utf8');
    if (!/Apache License/.test(text) || !/Version 2\.0/.test(text)) violations.push('packages/runner/LICENSE is not the Apache License, Version 2.0 text.');
  }

  const workspace = workspacePackages(repoRoot);
  const byName = new Map(workspace.map((w) => [w.name, w]));
  const forbiddenNames = new Set(workspace.filter((w) => !isPermissive(w.license)).map((w) => w.name));
  const describeForbidden = (name) => {
    const w = byName.get(name);
    return w.license === null ? `a workspace package with NO licence declared (treated as AGPL: the root is)` : `an ${w.license} workspace package`;
  };

  // 2. declared dependencies
  for (const field of DEP_FIELDS) {
    for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
      if (forbiddenNames.has(dep)) violations.push(`packages/runner/package.json ${field} names "${dep}", ${describeForbidden(dep)}. The Runner is Apache-2.0 and may not depend on it.`);
      else if (byName.has(dep) && !String(spec).startsWith('workspace:')) {
        // a permissive workspace package from the registry: fine
      } else if (/^(?:workspace|link|file|portal):/.test(String(spec)) && !byName.has(dep)) {
        violations.push(`packages/runner/package.json ${field} "${dep}": "${spec}" points into the repository, and "${dep}" is not a known permissive workspace package.`);
      }
    }
  }
  // permissive workspace deps must not themselves reach a forbidden one
  const reach = (name, trail) => {
    const w = byName.get(name);
    if (!w || trail.includes(name)) return;
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dep of Object.keys(w.pkg[field] ?? {})) {
        if (forbiddenNames.has(dep)) violations.push(`packages/runner reaches "${dep}" through "${[...trail, name].join('" > "')}", which is ${describeForbidden(dep)}.`);
        else reach(dep, [...trail, name]);
      }
    }
  };
  for (const field of DEP_FIELDS) for (const dep of Object.keys(pkg[field] ?? {})) if (byName.has(dep) && !forbiddenNames.has(dep)) reach(dep, []);

  // 3. source imports
  for (const sub of SOURCE_DIRS) {
    for (const file of walk(join(runnerDir, sub))) {
      const rel = relative(repoRoot, file).split(sep).join('/');
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const target = resolve(dirname(file), spec);
          if (target !== runnerDir && !target.startsWith(runnerDir + sep)) violations.push(`${rel} imports "${spec}", which resolves outside packages/runner.`);
          continue;
        }
        const bare = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (forbiddenNames.has(bare)) violations.push(`${rel} imports "${spec}", ${describeForbidden(bare)}.`);
        else if (bare.startsWith('@storyos/') && bare !== RUNNER_NAME && !byName.has(bare)) {
          violations.push(`${rel} imports "${spec}", a @storyos package this check cannot identify. Cannot tell: failing.`);
        }
      }
    }
  }

  // 4. production dependencies carry permissive licences only
  const { closure, problems } = productionClosure(runnerDir, pkg, byName);
  for (const p of problems) violations.push(`packages/runner: ${p}`);
  for (const dep of closure) {
    if (!expressionIsPermissive(dep.license)) violations.push(`production dependency "${dep.name}" is licensed ${JSON.stringify(dep.license)}, which is not on the Runner's permissive-only list (${[...PERMISSIVE].join(', ')}).`);
  }
  return violations;
}

function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--root');
  const repoRoot = i !== -1 && args[i + 1] ? resolve(args[i + 1]) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = checkBoundary({ repoRoot });
  if (violations.length === 0) {
    console.log('Runner licence boundary: packages/runner is Apache-2.0 and depends on no AGPL workspace package. OK');
    return;
  }
  console.error(`Runner licence boundary: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  - ${v}`);
  console.error('\npackages/runner is Apache-2.0 inside an AGPL monorepo (ADR-0021 section 9): it may not depend on, import or copy from AGPL code.');
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
