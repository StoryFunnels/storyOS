// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_MAX_CHARS, SUMMARY_MAX_CHARS } from '../src/claim-loop.js';
import { EXIT_KINDS, PROTOCOL_VERSION, REQUEST_CONTRACT, TOOL_REPORT_FIELDS } from '../src/protocol/types.js';

/**
 * The Runner's request shapes against the SERVER'S OWN contract, `docs/api/openapi.json`, read here as DATA. Nothing from the AGPL
 * packages is imported (the boundary check, scripts/check-runner-license-boundary.mjs, would fail the build if it were): the test
 * parses a JSON file. When the server changes a runner route's body, this fails on the Runner's side too, in CI.
 *
 * What this does NOT cover: responses (the server's openapi does not type them) and behaviour (see the PR's "NOT VERIFIED").
 */
interface Schema {
  type?: string;
  properties?: Record<string, Schema & { enum?: string[]; maxLength?: number; maxItems?: number; maximum?: number; items?: Schema }>;
  required?: string[];
}
interface OpenApi {
  paths: Record<string, unknown>;
  components: { schemas: Record<string, Schema> };
}

const here = dirname(fileURLToPath(import.meta.url));
const openapi = JSON.parse(readFileSync(join(here, '..', '..', '..', 'docs', 'api', 'openapi.json'), 'utf8')) as OpenApi;

describe('the Runner speaks the server\'s published contract', () => {
  for (const [dto, contract] of Object.entries(REQUEST_CONTRACT)) {
    it(`${dto}: ${contract.path}`, () => {
      expect(Object.keys(openapi.paths), `the server has no ${contract.path}`).toContain(contract.path);
      const schema = openapi.components.schemas[dto];
      expect(schema, `the server has no schema ${dto}`).toBeDefined();
      const sent = [...contract.required, ...contract.optional].sort();
      expect(Object.keys(schema!.properties ?? {}).sort(), 'the properties the server accepts and the ones the Runner may send differ').toEqual(sent);
      expect([...(schema!.required ?? [])].sort(), 'the properties the server requires and the ones the Runner always sends differ').toEqual([...contract.required].sort());
    });
  }

  it('every /runner/v1 route the server publishes is one this Runner knows about', () => {
    const server = Object.keys(openapi.paths).filter((p) => p.startsWith('/api/v1/runner/v1/')).sort();
    const known = Object.values(REQUEST_CONTRACT).map((c) => c.path).sort();
    expect(server).toEqual(known);
  });

  it('the exit kinds and the tool report fields are the server\'s', () => {
    const complete = openapi.components.schemas.WakeCompleteDto!.properties!;
    expect([...complete.exit!.enum!].sort()).toEqual([...EXIT_KINDS].sort());
    const toolProps = openapi.components.schemas.RunnerPairDto!.properties!.tools!.items!.properties!;
    expect(Object.keys(toolProps).sort()).toEqual([...TOOL_REPORT_FIELDS].sort());
    const beat = openapi.components.schemas.RunnerHeartbeatDto!.properties!.tools!.items!.properties!;
    expect(Object.keys(beat).sort()).toEqual([...TOOL_REPORT_FIELDS].sort());
  });

  it('what the Runner sends never exceeds what the server accepts', () => {
    const complete = openapi.components.schemas.WakeCompleteDto!.properties!;
    expect(SUMMARY_MAX_CHARS + 100).toBeLessThanOrEqual(complete.summary!.maxLength!); // the cap plus its "[cut: ...]" note
    expect(ERROR_MAX_CHARS + 100).toBeLessThanOrEqual(complete.error!.maxLength!);
    expect(200).toBeLessThanOrEqual(complete.session_id!.maxLength!);
    expect(60).toBeLessThanOrEqual(complete.tool_version!.maxLength!);
    const claim = openapi.components.schemas.WakeClaimDto!.properties!;
    expect(25).toBeLessThanOrEqual(claim.wait_seconds!.maximum!);
    expect(PROTOCOL_VERSION).toBeLessThanOrEqual(openapi.components.schemas.RunnerPairDto!.properties!.protocol_version!.maximum!);
  });
});
