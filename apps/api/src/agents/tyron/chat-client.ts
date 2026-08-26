import { env } from '../../config/env';

/**
 * Tyron's chat/tool-loop client (#357b, ADR-0016).
 *
 * `managed-ai-client.ts` is deliberately one-shot completions only, and its own
 * comment names this as "the still-open, ADR-worthy scope `ManagedAiRuntime`'s
 * comment declined to invent under cover of a different ticket". ADR-0016 is that
 * ADR, and this is that client.
 *
 * Kept SEPARATE from `ManagedAiClient` rather than widening it. The proposer's
 * contract is "send a prompt, get JSON back, count tokens" and it is used by the
 * Architect on a metered path; a multi-turn tool loop has a different shape, a
 * different failure model, and different callers. Widening the one-shot client
 * to carry both would make every Architect call pay for a tool-loop's
 * complexity.
 *
 * Plain `fetch`, no SDK — the same choice `managed-ai-client.ts` made, and for
 * the same reason: Chat Completions is a single POST. (The MCP client in
 * `tool-catalog.ts` DOES take an SDK, because its transport carries a handshake,
 * session ids and SSE framing. The two decisions are not inconsistent; they are
 * the same question with different answers.)
 */

export interface ChatToolDef {
  name: string;
  description: string;
  /** JSON Schema, forwarded verbatim from the MCP catalog — never re-described. */
  parameters: unknown;
}

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant turns that called tools. */
  toolCalls?: ChatToolCall[];
  /** Tool results carry the id of the call they answer. */
  toolCallId?: string;
}

export interface ChatReply {
  content: string;
  toolCalls: ChatToolCall[];
  tokensIn: number;
  tokensOut: number;
}

export interface TyronChatClient {
  chat(messages: ChatMessage[], tools: ChatToolDef[]): Promise<ChatReply>;
}

/** Shape the wire format expects. Kept local so the domain types above stay clean. */
function toWire(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

export class OpenAiTyronChatClient implements TyronChatClient {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async chat(messages: ChatMessage[], tools: ChatToolDef[]): Promise<ChatReply> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(toWire),
        ...(tools.length
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
              tool_choice: 'auto',
            }
          : {}),
        temperature: 0.2,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      /*
       * The provider's raw body goes to the LOG, never to the user.
       *
       * Found live: a rejected key produced OpenAI's full JSON error — including
       * the key prefix and a link to the account page — rendered verbatim in a
       * member's chat panel. Two problems in one. It was instance CONFIGURATION
       * surfacing to an end user who can do nothing about it, and it read like a
       * crash rather than an explanation.
       *
       * The operator still needs the detail, so it is logged. What the user gets
       * is the CATEGORY of failure, which is the part that tells them whether to
       * retry or to fetch someone who can fix it.
       */
      process.stderr.write(
        `storyos-tyron: model call failed (HTTP ${res.status}): ${body.slice(0, 1000)}\n`,
      );
      throw new Error(modelFailureMessage(res.status));
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const msg = data.choices?.[0]?.message;
    return {
      content: msg?.content ?? '',
      toolCalls: (msg?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        /*
         * A model can emit syntactically invalid JSON here. Falling back to an
         * empty object rather than throwing keeps one malformed call from
         * killing the whole turn — the tool will reject it and the loop hands
         * that back so the model can correct itself, which is the same
         * self-correction path a wrong argument already takes.
         */
        arguments: safeParse(c.function.arguments),
      })),
      tokensIn: data.usage?.prompt_tokens ?? 0,
      tokensOut: data.usage?.completion_tokens ?? 0,
    };
  }
}

/**
 * What the USER is told when the model call fails.
 *
 * Grouped by what the reader can do about it: a configuration fault is somebody
 * else's job and saying so stops them retrying forever; a rate limit is worth
 * retrying; anything else is honestly unknown.
 */
function modelFailureMessage(status: number): string {
  if (status === 401 || status === 403) {
    return "I can't reach the AI service — this instance's API key was rejected. That's a configuration problem on our side, not something you did; an admin needs to look at it.";
  }
  if (status === 429) {
    return "The AI service is rate-limiting us at the moment. Worth trying again shortly.";
  }
  if (status >= 500) {
    return 'The AI service is having trouble. Worth trying again shortly.';
  }
  return "I couldn't complete that — the AI service refused the request.";
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Built from env, `undefined` when unconfigured — every self-host and any dev box
 * without a key. The caller turns that into a plain "Tyron is not configured"
 * rather than a crash, exactly as `defaultManagedAiClient()` does for its sibling.
 *
 * The model is read from env with NO hardcoded fallback name here (#357: "the
 * model comes from env — changing tier is a config change"). That matters more
 * than usual: #353 decided there is no spend ceiling, so the model tier is
 * currently the only cost lever there is.
 */
export function defaultTyronChatClient(): TyronChatClient | undefined {
  const apiKey = env().OPENAI_API_KEY;
  if (!apiKey) return undefined;
  return new OpenAiTyronChatClient(apiKey, env().OPENAI_MODEL);
}
