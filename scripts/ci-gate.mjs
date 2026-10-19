#!/usr/bin/env node
/**
 * #865 / #953 — the decision behind the required `ci` status. Reads the `needs` context as JSON
 * (NEEDS) and `changes`' verdict (DOCS_ONLY). Every job must be `success`, with ONE exception:
 * `test-api` and `test-other` may be `skipped`, and only when `changes` itself succeeded and said
 * docs-only. A test job skipped for any other reason (a failed dependency, a bad `if`) stays red:
 * a gate that lets "didn't run" through lets anything through.
 */
import { pathToFileURL } from 'node:url';

const SKIPPABLE = new Set(['test-api', 'test-other']);

export function notGreen(needs, docsOnly) {
  const docsOk = docsOnly === 'true' && needs.changes?.result === 'success';
  return Object.entries(needs)
    .filter(([name, v]) => !(v.result === 'success' || (docsOk && SKIPPABLE.has(name) && v.result === 'skipped')))
    .map(([name]) => name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const needs = JSON.parse(process.env.NEEDS || '{}');
  for (const [name, v] of Object.entries(needs)) console.log(`${name}: ${v.result}`);
  const bad = notGreen(needs, process.env.DOCS_ONLY);
  if (bad.length) {
    console.error(`::error::not green: ${bad.join(' ')}`);
    process.exit(1);
  }
  console.log('all required jobs succeeded');
}
