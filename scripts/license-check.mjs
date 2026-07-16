#!/usr/bin/env node
/**
 * Dependency-license scan + SBOM generator (MN-235).
 *
 * Runs `pnpm licenses list` over the *production* dependency tree, fails the
 * build if any package carries a license that is not compatible with shipping
 * inside an AGPL-3.0-or-later product, and writes a CycloneDX SBOM.
 *
 *   node scripts/license-check.mjs            # scan prod deps, write sbom.cdx.json
 *   node scripts/license-check.mjs --all      # include devDependencies too
 *   node scripts/license-check.mjs --sbom p   # write SBOM to path p
 *
 * Dev dependencies don't ship, so by default they're excluded from the gate.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const includeDev = args.includes('--all');
const sbomPath = (() => {
  const i = args.indexOf('--sbom');
  return i !== -1 && args[i + 1] ? args[i + 1] : 'sbom.cdx.json';
})();

/**
 * SPDX identifiers we allow in shipped dependencies. Permissive licenses plus
 * the copyleft families that are compatible with distributing them as part of
 * an AGPL-3.0-or-later work (LGPL, MPL-2.0, GPL-3/AGPL-3). GPL-2.0-*only* is
 * deliberately absent — it is incompatible with (A)GPLv3.
 */
const ALLOW = new Set([
  '0BSD',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC-BY-4.0',
  'CC0-1.0',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'OFL-1.1',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/**
 * Decide whether an SPDX expression is acceptable. Handles simple dual licenses:
 * `(A OR B)` passes if either side is allowed; `(A AND B)` needs both allowed.
 * Anything unparseable (custom text, "UNKNOWN", "SEE LICENSE IN …") fails.
 */
function isAllowed(expr) {
  if (!expr || expr === 'UNKNOWN') return false;
  const clean = expr.replace(/[()]/g, ' ').trim();
  if (ALLOW.has(clean)) return true;
  if (/\bOR\b/.test(clean)) {
    return clean.split(/\bOR\b/).some((p) => isAllowed(p.trim()));
  }
  if (/\bAND\b/.test(clean)) {
    return clean.split(/\bAND\b/).every((p) => isAllowed(p.trim()));
  }
  return ALLOW.has(clean);
}

function loadLicenses() {
  const argv = ['licenses', 'list', '--json'];
  if (!includeDev) argv.push('--prod');
  const out = execFileSync('pnpm', argv, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // `pnpm licenses list` prints nothing but a message when there are no deps.
  const trimmed = out.trim();
  if (!trimmed || trimmed[0] !== '{') return {};
  return JSON.parse(trimmed);
}

// pnpm groups results by license string: { "MIT": [ {name, versions, ...}, ... ] }
const byLicense = loadLicenses();
const components = [];
for (const [license, pkgs] of Object.entries(byLicense)) {
  for (const pkg of pkgs) {
    for (const version of pkg.versions ?? ['0.0.0']) {
      components.push({
        name: pkg.name,
        version,
        license,
        author: pkg.author,
        homepage: pkg.homepage,
      });
    }
  }
}
components.sort((a, b) =>
  `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
);

const violations = components.filter((c) => !isAllowed(c.license));

// --- CycloneDX 1.5 SBOM ---------------------------------------------------
const purl = (c) =>
  `pkg:npm/${c.name.replace('@', '%40')}@${encodeURIComponent(c.version)}`;
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: 'storyos',
      // No Date.now(): keep the SBOM deterministic so it never adds diff noise.
    },
    properties: [
      { name: 'storyos:scope', value: includeDev ? 'all' : 'production' },
    ],
  },
  components: components.map((c) => ({
    type: 'library',
    'bom-ref': purl(c),
    name: c.name,
    version: c.version,
    purl: purl(c),
    licenses: [
      /\b(OR|AND)\b|[()]/.test(c.license)
        ? { expression: c.license }
        : { license: { id: c.license } },
    ],
  })),
};
writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);

// --- Report ---------------------------------------------------------------
const counts = {};
for (const c of components) counts[c.license] = (counts[c.license] ?? 0) + 1;
console.log(
  `Scanned ${components.length} ${includeDev ? '' : 'production '}dependency versions:`,
);
for (const [lic, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  const mark = isAllowed(lic) ? '  ok ' : ' FAIL';
  console.log(`  ${mark}  ${String(n).padStart(4)}  ${lic}`);
}
console.log(`SBOM written to ${sbomPath} (CycloneDX 1.5).`);

if (violations.length) {
  console.error(
    `\n✖ ${violations.length} dependency version(s) with a disallowed or unknown license:`,
  );
  for (const v of violations) {
    console.error(`  - ${v.name}@${v.version}: ${v.license}`);
  }
  console.error(
    '\nResolve, replace, or — if genuinely compatible — add the SPDX id to ALLOW in scripts/license-check.mjs with a note.',
  );
  process.exit(1);
}
console.log('\n✓ All shipped dependency licenses are AGPL-3.0-compatible.');
