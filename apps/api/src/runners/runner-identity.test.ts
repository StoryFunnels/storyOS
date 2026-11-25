import { describe, expect, it } from 'vitest';
import { MASKED_RUNNER_NAME, maskRunnerStamp, maskRunValues, redactRunnerInText, seesRunnerIdentity } from './runner-identity';

describe('runner identity for a guest (ticket #1227)', () => {
  it('only a guest is masked: a member, an admin and an internal caller see the Runner', () => {
    expect(seesRunnerIdentity({ role: 'guest' })).toBe(false);
    for (const role of ['member', 'admin'] as const) expect(seesRunnerIdentity({ role })).toBe(true);
    expect(seesRunnerIdentity(undefined)).toBe(true);
  });

  it('a Run keeps what it says happened and loses which computer it happened on', () => {
    const out = maskRunValues({ runner: 'SECRET-MACHINE-7', tool: 'claude-code', tool_version: '2.1', summary: 'Triaged it', tokens_in: 12 });
    expect(out).toEqual({ runner: MASKED_RUNNER_NAME, summary: 'Triaged it', tokens_in: 12 });
  });

  it('a Run with no Runner is not given one', () => {
    expect(maskRunValues({ summary: 'queued' })).toEqual({ summary: 'queued' });
    expect(maskRunValues({ runner: '', summary: 'x' })).toEqual({ runner: '', summary: 'x' });
  });

  it('the Steps line that names the machine and tool is redacted, other lines are not', () => {
    const steps = [
      { type: 'bulletListItem', content: [{ type: 'text', text: ' — OK on Ievgen laptop with claude-code 2.1.104; tokens not reported by the tool. Summary: done', styles: {} }] },
      { type: 'bulletListItem', content: [{ type: 'text', text: ' — Queued (manual)', styles: {} }] },
    ];
    const out = JSON.stringify(redactRunnerInText(steps, 'Ievgen laptop', 'claude-code'));
    expect(out).not.toContain('Ievgen laptop');
    expect(out).not.toContain('claude-code');
    expect(out).toContain('OK on a Runner with the tool; tokens not reported');
    expect(out).toContain('Queued (manual)');
  });

  it('the stamp on a comment or version: the id goes, the name reads "a Runner", an unstamped row stays unstamped', () => {
    const stamped = { id: 'c1', runner_id: 'r1', runner_name: 'SECRET' };
    expect(maskRunnerStamp(stamped, { role: 'guest' })).toEqual({ id: 'c1', runner_id: null, runner_name: MASKED_RUNNER_NAME });
    expect(maskRunnerStamp(stamped, { role: 'member' })).toEqual(stamped);
    const plain = { id: 'c2', runner_id: null, runner_name: null };
    expect(maskRunnerStamp(plain, { role: 'guest' })).toEqual(plain);
  });
});
