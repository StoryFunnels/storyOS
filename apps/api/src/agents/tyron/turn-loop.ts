import { checkCeilings, type CeilingStop } from './ceilings';
import { classifyWrite, type SafetyVerdict } from './write-safety';
import type { ChatMessage, ChatToolCall, ChatToolDef, TyronChatClient } from './chat-client';
import type { TyronToolCatalog } from './tool-catalog';
import { ToolsUnreachableError } from './tool-catalog';

/**
 * Tyron's turn loop (#357b, ADR-0016).
 *
 * The one place the pieces meet: the catalog supplies the tools, the model picks
 * them, `write-safety` decides whether a pick may proceed, `ceilings` bounds the
 * whole thing, and the caller streams the outcome.
 *
 * **It emits OUTCOMES, never a tool trace** (#357). The events below carry text,
 * a status line, a question, or a stop — deliberately not "calling add_field…".
 * The structured record of what was done is stored on the thread for #354 replay
 * and is not surfaced.
 */

export type TurnEvent =
  /** Prose for the user. */
  | { type: 'text'; text: string }
  /** A short "still working" line — outcomes accumulating, not machinery. */
  | { type: 'status'; text: string }
  /** A confirmation or approval the user must answer before anything is applied. */
  | {
      type: 'question';
      verdict: Extract<SafetyVerdict, { kind: 'confirm' | 'approval_gate' }>;
      tool: string;
      /**
       * #357d — the exact call awaiting an answer. Carried so the caller can
       * store it and execute precisely what was classified, rather than
       * reconstructing it from the prose and hoping the two agree.
       */
      call: ChatToolCall;
    }
  /** A ceiling stopped the run. */
  | { type: 'stopped'; stop: CeilingStop }
  /** The turn ended cleanly. `actions` is persisted, not displayed. */
  | { type: 'done'; actions: Array<{ name: string; arguments: Record<string, unknown> }> }
  /** Something failed. The turn halts; work already applied is kept. */
  | { type: 'error'; text: string };

export interface TurnDeps {
  chat: TyronChatClient;
  catalog: TyronToolCatalog;
  /** Prior turns, oldest first. */
  history: ChatMessage[];
}

/**
 * The instructions Tyron runs under.
 *
 * Short on purpose. Every line here is a rule the model can ignore, so anything
 * that MUST hold is enforced in code instead — the tools it may call come from a
 * scope-gated catalog, and every write is classified before it runs. This prompt
 * shapes tone and approach; it is not a security boundary.
 */
export const TYRON_SYSTEM_PROMPT = [
  'You are Tyron, an assistant inside StoryOS — a workspace of user-defined relational databases.',
  'You act as the person talking to you, with exactly their permissions. If something is refused, say so plainly and move on.',
  '',
  'Read before you write: inspect a database\'s schema before creating or updating records in it.',
  'When you have finished, state plainly WHAT CHANGED in one or two sentences. Never narrate the steps you took and never mention tool names.',
  'If you cannot answer exactly, say so rather than guessing — an approximate count presented as a fact is worse than no answer.',
].join('\n');

/**
 * Run one turn.
 *
 * An async generator so the caller can stream without this file knowing anything
 * about HTTP, SSE or sockets — the same seam reasoning as `AgentRuntime`
 * returning an `AsyncIterable<Step>` in ADR-0010 §3.
 */
export async function* runTurn(
  userMessage: string,
  deps: TurnDeps,
): AsyncGenerator<TurnEvent, void, undefined> {
  const { chat, catalog, history } = deps;

  let tools: ChatToolDef[];
  try {
    tools = (await catalog.list()).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  } catch (err) {
    /*
     * ADR-0016 §1 accepts an availability edge (api → mcp) and requires that when
     * it breaks, Tyron says it cannot reach its tools rather than degrading into
     * a chat box that answers confidently and acts on nothing.
     */
    yield {
      type: 'error',
      text: err instanceof ToolsUnreachableError ? err.message : 'I could not load my tools just now.',
    };
    return;
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: TYRON_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userMessage },
  ];

  /** Persisted on the thread for #354 replay. Never emitted as a trace. */
  const actions: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let toolCallsThisTurn = 0;
  let turnsThisRun = 0;

  for (;;) {
    const stop = checkCeilings({ toolCallsThisTurn, turnsThisRun });
    if (stop) {
      yield { type: 'stopped', stop };
      return;
    }
    turnsThisRun++;

    let reply;
    try {
      reply = await chat.chat(messages, tools);
    } catch (err) {
      /*
       * #357: on failure it STOPS and reports what did and did not happen. It
       * does not carry on with a broken assumption, and it does not silently roll
       * back work the user may want to keep — so the actions already applied are
       * reported as kept rather than quietly reversed.
       */
      yield {
        type: 'error',
        text:
          `I hit a problem partway through and stopped. ` +
          (actions.length
            ? `The ${actions.length} change${actions.length === 1 ? '' : 's'} I had already made ${actions.length === 1 ? 'is' : 'are'} still in place — nothing was undone. `
            : 'Nothing was changed. ') +
          (err instanceof Error ? err.message : String(err)),
      };
      return;
    }

    if (reply.toolCalls.length === 0) {
      if (reply.content) yield { type: 'text', text: reply.content };
      yield { type: 'done', actions };
      return;
    }

    // A gated call ends the turn as a QUESTION. Checked before ANY call in the
    // batch executes, so a delete cannot slip through beside an allowed write.
    for (const call of reply.toolCalls) {
      const verdict = classifyWrite({ tool: call.name, ...extractIntent(call) });
      if (verdict.kind === 'refuse') {
        yield { type: 'text', text: verdict.message };
        yield { type: 'done', actions };
        return;
      }
      if (verdict.kind === 'confirm' || verdict.kind === 'approval_gate') {
        yield { type: 'question', verdict, tool: call.name, call };
        yield { type: 'done', actions };
        return;
      }
    }

    messages.push({ role: 'assistant', content: reply.content, toolCalls: reply.toolCalls });
    if (reply.content) yield { type: 'status', text: reply.content };

    for (const call of reply.toolCalls) {
      toolCallsThisTurn++;
      const result = await catalog.call(call.name, call.arguments);
      actions.push({ name: call.name, arguments: call.arguments });
      /*
       * A tool failure is handed BACK to the model rather than ending the turn.
       * A permission denial or a wrong argument is a normal outcome the model can
       * recover from (#357: "a permission-denied action produces a plain
       * explanation, not a crash"), and aborting would turn every recoverable
       * mistake into a dead end.
       */
      messages.push({ role: 'tool', toolCallId: call.id, content: result.text });
    }
  }
}

/**
 * What the safety layer needs to judge a call, pulled from its arguments.
 *
 * Deliberately conservative: only fields that are unambiguous are read, and
 * nothing is guessed. A wrong `affected` count would put a wrong number in a
 * confirmation, which is worse than putting none — the number is the whole
 * reason the confirmation changes anyone's mind.
 */
function extractIntent(call: ChatToolCall): { affected?: number; databaseName?: string; fieldName?: string } {
  const a = call.arguments;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const ids = a['record_ids'];
  return {
    affected: Array.isArray(ids) ? ids.length : a['record'] != null ? 1 : undefined,
    databaseName: str(a['database']),
    fieldName: str(a['field']) ?? str(a['name']),
  };
}
