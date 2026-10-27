import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiCreditsService } from '../billing/ai-credits.service';
import { ManagedAiRuntime } from './agent-runtime';
import { ManagedAiProposer } from './architect-proposer';
import { OpenAiManagedAiClient } from './managed-ai-client';

/**
 * #1109 — what the shared managed client actually puts on the wire.
 *
 * OpenAI's Chat Completions API refuses `response_format: json_object` unless
 * the word "json" appears in the messages (documented behaviour; NOT exercised
 * against the real API here — there is no key in CI). So the part that IS
 * provable offline is the request: capture it with a stubbed fetch and assert
 * the precondition for that refusal never holds.
 */
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  body: { messages: Array<{ role: string; content: string }>; response_format?: { type: string } };
}

function stubFetch(content = 'ok'): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    calls.push({ body: JSON.parse(String(init?.body)) });
    return new Response(
      JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
      { status: 200 },
    );
  }) as typeof fetch;
  return calls;
}

const mentionsJson = (c: Captured) => c.body.messages.some((m) => /json/i.test(m.content));

describe('OpenAiManagedAiClient request shape (#1109)', () => {
  it('never requests JSON mode on messages that do not mention JSON (a plain prompt, default options)', async () => {
    const calls = stubFetch();
    await new OpenAiManagedAiClient('k', 'gpt-test').complete('Summarize the lead Acme Corp in one sentence.');
    const [c] = calls;
    if (c!.body.response_format?.type === 'json_object') expect(mentionsJson(c!)).toBe(true);
  });

  it('adds the JSON instruction itself in JSON mode when the prompt lacks the word, leaving the user prompt untouched', async () => {
    const calls = stubFetch();
    await new OpenAiManagedAiClient('k', 'gpt-test').complete('Classify Acme.', { responseFormat: 'json' });
    const c = calls[0]!;
    expect(c.body.response_format).toEqual({ type: 'json_object' });
    expect(mentionsJson(c)).toBe(true);
    expect(c.body.messages.at(-1)).toEqual({ role: 'user', content: 'Classify Acme.' });
  });

  it('does not add anything when the prompt already says JSON (Architect/agent requests stay byte-identical)', async () => {
    const calls = stubFetch();
    await new OpenAiManagedAiClient('k', 'gpt-test').complete('Reply with a JSON object.');
    const c = calls[0]!;
    expect(c.body.response_format).toEqual({ type: 'json_object' });
    expect(c.body.messages).toEqual([{ role: 'user', content: 'Reply with a JSON object.' }]);
  });

  it('plain-text mode sends no response_format and no JSON instruction', async () => {
    const calls = stubFetch('Enterprise');
    const out = await new OpenAiManagedAiClient('k', 'gpt-test').complete('Classify Acme.', { responseFormat: 'text' });
    const c = calls[0]!;
    expect(c.body.response_format).toBeUndefined();
    expect(c.body.messages).toEqual([{ role: 'user', content: 'Classify Acme.' }]);
    expect(out.text).toBe('Enterprise');
  });
});

describe('callers that rely on JSON keep asking for it (#1109)', () => {
  it('the Architect proposer calls complete() in JSON mode (default) with a prompt that says JSON', async () => {
    const complete = vi.fn().mockResolvedValue({ text: '{}', tokensIn: 1, tokensOut: 1 });
    const aiCredits = {
      canUseManagedAi: vi.fn().mockResolvedValue(true),
      recordUsage: vi.fn().mockResolvedValue(undefined),
    } as unknown as AiCreditsService;
    await new ManagedAiProposer({ complete }, aiCredits).propose({ workspaceId: 'w', goal: 'x' }).catch(() => undefined);
    expect(complete).toHaveBeenCalledTimes(1);
    const [prompt, options] = complete.mock.calls[0]!;
    expect(prompt).toMatch(/json/i);
    expect(options?.responseFormat ?? 'json').toBe('json');
  });

  it('the managed agent runtime calls complete() in JSON mode (default) with a prompt that says JSON', async () => {
    const complete = vi.fn().mockResolvedValue({ text: '{"steps":[]}', tokensIn: 1, tokensOut: 1 });
    // An empty plan is rejected by the runtime's own schema; only the request matters here.
    await (async () => {
      const steps = new ManagedAiRuntime({ complete }).execute({
        workspaceId: 'w',
        agent: { id: 'a', name: 'A', scopes: ['read'], goal: 'g' },
        principal: { userId: 'u', scope: 'read' },
        inputRecordId: undefined,
      } as never);
      await steps[Symbol.asyncIterator]().next();
    })().catch(() => undefined);
    const [prompt, options] = complete.mock.calls[0]!;
    expect(prompt).toMatch(/json/i);
    expect(options?.responseFormat ?? 'json').toBe('json');
  });
});
