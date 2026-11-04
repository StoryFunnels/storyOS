// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { RunnerClient } from './client.js';

/** ticket #1137: a 204 has no body, so "not now, and until when" rides on two headers. */
const clientFor = (res: Response) => new RunnerClient({ server: 'https://app.example', token: 'mn_run_x', runnerVersion: '0.1.0', fetchImpl: async () => res });

describe('the claim answer when the server holds the Runner back', () => {
  it('reads the reason and the resume time from the 204 headers', async () => {
    const res = new Response(null, { status: 204, headers: { 'x-runner-hold-reason': 'working_hours', 'x-runner-resumes-at': '2027-01-13T20:00:00.000Z' } });
    expect(await clientFor(res).claim({ max: 1 })).toEqual({ wakes: [], hold: { reason: 'working_hours', resumes_at: '2027-01-13T20:00:00.000Z' } });
  });
  it('a reason with no time is still a hold; a plain 204 stays undefined (nothing queued)', async () => {
    expect(await clientFor(new Response(null, { status: 204, headers: { 'x-runner-hold-reason': 'reserve' } })).claim({ max: 1 })).toEqual({ wakes: [], hold: { reason: 'reserve' } });
    expect(await clientFor(new Response(null, { status: 204 })).claim({ max: 1 })).toBeUndefined();
  });
});
