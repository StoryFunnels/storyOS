import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Guard for the MCP Registry metadata (ticket #1313). `server.json` at the repo root
// describes the published `@storyos/mcp` package; the registry verifies it against the
// npm tarball. Four things drift silently and only fail at publish time, so they fail
// here instead: the two versions, the package entry's version, the `mcpName` marker the
// registry reads from the published package.json, and the 100-character description cap.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(resolve(root, rel), 'utf8'));

/** Returns a list of problems (empty when consistent). Pure, so the rules are testable. */
export function registryProblems(pkg, server) {
  const problems = [];
  if (typeof pkg.mcpName !== 'string' || pkg.mcpName === '') {
    problems.push('packages/mcp/package.json has no mcpName');
  } else if (pkg.mcpName !== server.name) {
    problems.push(`mcpName (${pkg.mcpName}) differs from server.json name (${server.name})`);
  }
  if (server.version !== pkg.version) {
    problems.push(`server.json version (${server.version}) differs from package.json version (${pkg.version})`);
  }
  const npmEntries = (server.packages ?? []).filter((p) => p.registryType === 'npm');
  if (npmEntries.length === 0) problems.push('server.json has no npm package entry');
  for (const entry of npmEntries) {
    if (entry.identifier !== pkg.name) {
      problems.push(`npm entry identifier (${entry.identifier}) differs from package name (${pkg.name})`);
    }
    if (entry.version !== pkg.version) {
      problems.push(`npm entry version (${entry.version}) differs from package.json version (${pkg.version})`);
    }
  }
  if (typeof server.description !== 'string' || server.description.length === 0) {
    problems.push('server.json description is missing');
  } else if (server.description.length > 100) {
    problems.push(`server.json description is ${server.description.length} characters (max 100)`);
  }
  return problems;
}

const pkg = () => readJson('packages/mcp/package.json');
const server = () => readJson('server.json');

test('the real server.json and packages/mcp/package.json agree', () => {
  assert.deepEqual(registryProblems(pkg(), server()), []);
});

test('rejects a server.json version that differs from package.json', () => {
  const problems = registryProblems(pkg(), { ...server(), version: '9.9.9' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /server\.json version/);
});

test('rejects an npm package entry whose version differs', () => {
  const s = server();
  s.packages = s.packages.map((p) => ({ ...p, version: '9.9.9' }));
  const problems = registryProblems(pkg(), s);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /npm entry version/);
});

test('rejects a package.json without mcpName', () => {
  const { mcpName: _drop, ...rest } = pkg();
  const problems = registryProblems(rest, server());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no mcpName/);
});

test('rejects an mcpName that differs from the server.json name', () => {
  const problems = registryProblems({ ...pkg(), mcpName: 'dev.storyos/other' }, server());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /differs from server\.json name/);
});

test('rejects a description over 100 characters, accepts exactly 100', () => {
  assert.equal(registryProblems(pkg(), { ...server(), description: 'x'.repeat(101) }).length, 1);
  assert.deepEqual(registryProblems(pkg(), { ...server(), description: 'x'.repeat(100) }), []);
});
