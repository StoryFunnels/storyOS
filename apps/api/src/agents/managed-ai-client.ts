import { env } from '../config/env';

/**
 * The model-calling boundary `ManagedAiRuntime`'s doc comment (agent-runtime.ts)
 * said this codebase didn't have yet: "no LLM client, no provider choice, no
 * prompt/tool-loop shape anywhere". MN-217c (#246) is the ticket that actually
 * needs one — the Architect's managed proposer — so it is built here, scoped
 * to exactly what `ManagedAiProposer` needs: send a prompt, get text back plus
 * real token counts to attribute on the AI-credits ledger. It is deliberately
 * NOT a general chat/tool-loop client (that is the still-open, ADR-worthy
 * scope `ManagedAiRuntime`'s comment declined to invent under cover of a
 * different ticket) — one-shot completions are all a plan proposal needs.
 */
export interface ManagedAiCompletion {
  /** The model's raw response text — expected to be JSON, but not parsed here. */
  text: string;
  tokensIn: number;
  tokensOut: number;
}

/**
 * The seam `ManagedAiProposer` depends on, never a concrete provider SDK —
 * same reasoning as `AgentRuntime` depending on the runtime interface rather
 * than a model directly. Swappable in tests, so the proposer's JSON-parsing,
 * schema-validation and metering logic are all provable without ever making a
 * real network call.
 */
export interface ManagedAiClient {
  complete(prompt: string): Promise<ManagedAiCompletion>;
}

/**
 * OpenAI's Chat Completions API over plain `fetch` (no SDK dependency — the
 * same approach packages/mcp/src/tools.ts's attach_file already uses for a
 * server-side fetch). `response_format: json_object` constrains the model to
 * syntactically-valid JSON; `ManagedAiProposer` still re-validates the parsed
 * result against `architectPlanDraftSchema` rather than trusting that
 * constraint alone — a model can satisfy JSON-mode and still hallucinate
 * fields the plan schema doesn't allow.
 */
export class OpenAiManagedAiClient implements ManagedAiClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(prompt: string): Promise<ManagedAiCompletion> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Managed AI provider call failed (HTTP ${res.status}): ${body.slice(0, 500)}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('Managed AI provider returned no content.');
    return {
      text,
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
    };
  }
}

/**
 * The default client, built from env — `undefined` when unconfigured
 * (OPENAI_API_KEY unset), which is every self-host and any dev box that
 * hasn't wired one. `ManagedAiProposer` treats `undefined` as "not
 * configured" and throws a clear 422 rather than silently degrading, exactly
 * as `ManagedAiRuntime`'s stub already does for the sibling runtime seam.
 */
export function defaultManagedAiClient(): ManagedAiClient | undefined {
  const apiKey = env().OPENAI_API_KEY;
  if (!apiKey) return undefined;
  return new OpenAiManagedAiClient(apiKey, env().OPENAI_MODEL);
}
