import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Hygiene guard: the public repo must not carry infrastructure identifiers, meaning the
// name of the hosting provider (current or former), its region codes, the production
// server's name, the private infrastructure repo's name, or the production server's
// address. Those live only in the private infrastructure repo.
//
// Every needle is assembled from fragments at runtime, so a plain-text search of the
// tree for any of those words does not match this file either, and the file needs no
// self-exclusion. Failures print `path:line (rule)` and never the matched text, so a
// failing CI log does not publish what it caught.

const j = (...parts) => parts.join('');
const alnum = (s) => `(?<![a-z0-9])${s}(?![a-z0-9])`;
const name = (s) => `(?<![a-z0-9])${s}(?![a-z])`; // a trailing digit is fine (a numbered host), a letter makes it another word

// [rule label, case-insensitive regex source]
const RULES = [
  ['provider', j('het', 'zner')],
  ['former-provider', j('kama', 'tera')],
  ['region-code', alnum(j('f', 'sn', '1'))],
  ['region-code', alnum(j('n', 'bg', '1'))],
  ['region-code', alnum(j('h', 'el', '1'))],
  ['server-name', name(['storyos', 'prod'].join('-'))],
  ['infra-repo', name(['storyos', 'infra'].join('-'))],
  // the previous production server's address (literal fragments, never spelled whole)
  ['prod-ip', alnum(['185', '237', '15', '102'].join('\\.'))],
].map(([label, src]) => [label, new RegExp(src, 'i')]);

// A public IPv4 address in prose/config files is almost always a server we run. Code and
// tests are exempt (they use well-known public resolvers as fixtures); ranges that carry no
// identity are allowed everywhere: loopback, private, link-local (the metadata IP the SSRF
// guard blocks), CGNAT, benchmarking and the documentation ranges.
const TEXT_FILE = /(\.(md|mdx|ya?ml|sh|toml|caddy|conf|env|example)$|(^|\/)(Dockerfile[^/]*|Caddyfile[^/]*|\.env[^/]*)$)/;
const IPV4 = /(?<![0-9.])((?:\d{1,3}\.){3}\d{1,3})(?![0-9]|\.\d)/g;

function isIdentityFreeIp(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => n > 255)) return true; // not an address (a version string, say)
  const [a, b, c] = o;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Findings as `path:line (rule)` strings for one file. The matched text is never included. */
export function scanFile(path, text) {
  const out = [];
  for (const [label, re] of RULES) {
    if (re.test(path)) out.push(`${path}:0 (${label}, in the file name)`);
  }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [label, re] of RULES) if (re.test(line)) out.push(`${path}:${i + 1} (${label})`);
    if (TEXT_FILE.test(path)) {
      for (const m of line.matchAll(IPV4)) {
        if (!isIdentityFreeIp(m[1])) out.push(`${path}:${i + 1} (public-ip)`);
      }
    }
  });
  return out;
}

const root = new URL('../', import.meta.url);
const SKIP = /(^|\/)(pnpm-lock\.yaml|package-lock\.json)$/;

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

test('no tracked file carries an infrastructure identifier', () => {
  const files = trackedFiles();
  assert.ok(files.length > 500, 'sanity: the tracked tree was listed');
  const found = [];
  for (const f of files) {
    if (SKIP.test(f)) continue;
    let buf;
    try {
      buf = readFileSync(new URL(f, root));
    } catch {
      continue; // deleted in the working tree, or a submodule entry
    }
    if (buf.length > 5 * 1024 * 1024 || buf.includes(0)) continue; // binary or huge: not prose
    found.push(...scanFile(f, buf.toString('utf8')));
  }
  assert.deepEqual(found, [], `infrastructure identifiers found (text withheld on purpose):\n${found.join('\n')}`);
});

test('the scan flags each kind of identifier, by place only', () => {
  const bad = [
    ['docs/a.md', `Host: ${j('Het', 'zner')} Cloud`, 'provider'],
    ['docs/a.md', `moved off ${j('Kama', 'tera')}`, 'former-provider'],
    ['docs/a.md', `region ${j('f', 'sn', '1')}`, 'region-code'],
    ['docs/a.md', `region ${j('N', 'BG', '1')}`, 'region-code'],
    ['docs/a.md', `region ${j('h', 'el', '1')}-dc2`, 'region-code'],
    ['docs/a.md', `box ${['storyos', 'prod'].join('-')}`, 'server-name'],
    ['docs/a.md', `repo ${['storyos', 'infra'].join('-')}`, 'infra-repo'],
    ['docs/a.md', `root@${['185', '237', '15', '102'].join('.')}`, 'prod-ip'],
    ['docs/a.md', 'ssh deploy@8.8.8.8', 'public-ip'],
    ['.github/workflows/x.yml', 'host: 93.184.216.34', 'public-ip'],
  ];
  for (const [path, text, rule] of bad) {
    const hits = scanFile(path, `ok line\n${text}\n`);
    assert.ok(hits.some((h) => h.startsWith(`${path}:2 (${rule}`)), `${rule} not flagged`);
    assert.ok(hits.every((h) => !h.includes(text) && !h.toLowerCase().includes(j('het', 'zner'))), 'a finding echoed the matched text');
  }
  assert.ok(scanFile(`docs/${j('het', 'zner')}.md`, '').length > 0, 'a file name is checked too');
});

test('the scan does not flag neutral wording or identity-free addresses', () => {
  const ok = [
    ['docs/a.md', 'One production server, defined in the private infrastructure repo.'],
    ['docs/a.md', 'the hosting provider'],
    ['docs/a.md', 'SSRF guard blocks 169.254.169.254 and 127.0.0.1, 10.0.0.5, 172.16.0.1, 192.168.1.1, 100.64.0.1, 203.0.113.9'],
    ['docs/a.md', '300.1.1.1 and 1.2.3 are not addresses'],
    ['apps/api/test/x.test.ts', "url: 'https://169.254.169.254/metadata/v1/userdata', resolver '8.8.8.8'"],
    ['docs/a.md', `a token like x${j('f', 'sn', '1')}y is not a region code, and Prodigy is not a server name`],
    ['docs/a.md', `${['storyos', 'prod'].join('-')}uction-readiness is not the server name`],
  ];
  for (const [path, text] of ok) assert.deepEqual(scanFile(path, text), [], text);
});
