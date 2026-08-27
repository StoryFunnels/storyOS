/**
 * Keep a turn inside the model's window (#404).
 *
 * Asked "how many contacts do we have?", Tyron failed with
 * `136922 tokens (130334 in the messages)` against a 128,000-token window. The
 * question is trivial; the failure is that answering it dragged an entire
 * database into the conversation.
 *
 * `turn-loop.ts` appended `result.text` verbatim with NO size limit anywhere,
 * and it stayed in `messages` for every subsequent iteration. So the loop's cost
 * grew with the size of the user's data, and nothing bounded it. A demo
 * workspace with 3 records passed every local check; 148 companies x 22 columns
 * did not. It failed hardest for exactly the users who matter.
 *
 * Two bounds live here, and neither is the real fix on its own — that is the
 * `aggregate` endpoint, so a count never fetches rows at all. These stop
 * everything ELSE from doing the same thing.
 */

/**
 * Rough tokens per character.
 *
 * A real tokenizer would be exact and would mean shipping one to the API for a
 * budget decision. ~4 chars/token is the standard English approximation, and the
 * cost of being wrong here is a slightly early trim rather than a wrong answer —
 * so the estimate is deliberately CONSERVATIVE (rounds up).
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/** One tool result may not exceed this. ~4k tokens: generous for a real answer, nowhere near a table. */
export const MAX_TOOL_RESULT_CHARS = 16_000;

/**
 * Total budget for the message history handed to the model.
 *
 * Well under a 128k window on purpose: the system prompt, the tool DEFINITIONS
 * (6,588 tokens in the failing transcript) and the reply itself all have to fit
 * alongside, and a budget that only just fits leaves no room for the answer.
 */
export const MAX_HISTORY_TOKENS = 60_000;

/**
 * Truncate one tool result, and SAY SO in the text the model reads.
 *
 * Silent truncation would be worse than the crash it prevents: the model would
 * receive twenty rows of a hundred and answer as though it had them all, which
 * manufactures exactly the confident wrong number #401 is about. The marker is
 * not decoration — it is the whole reason this is safe to do.
 */
export function capToolResult(text: string, max: number = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const kept = text.slice(0, max);
  return (
    `${kept}\n\n[TRUNCATED: this result was ${text.length} characters and only the first ${max} are shown. ` +
    `You are NOT seeing the whole set. Do not count, total or summarise from it — ` +
    `use the aggregate/count tool for numbers, or narrow the query with a filter.]`
  );
}

export interface BudgetMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

/**
 * Drop the oldest TOOL results until the history fits.
 *
 * Tool results are the bulky, least-reusable part of a conversation: once the
 * model has answered from them, the prose turns carry the thread and the raw
 * rows do not. Prose is never dropped, so the conversation stays coherent even
 * when its evidence has been trimmed.
 *
 * The system prompt and the most recent user message are never dropped either —
 * losing the instructions or the actual question to save space would trade a
 * crash for an answer to the wrong question.
 *
 * A dropped result leaves a MARKER, for the same reason truncation does: the
 * model must not believe it still has data it can no longer see.
 */
export function trimHistory<T extends BudgetMessage>(messages: T[], budget: number = MAX_HISTORY_TOKENS): T[] {
  const total = (list: T[]) => list.reduce((n, m) => n + estimateTokens(m.content ?? ''), 0);
  if (total(messages) <= budget) return messages;

  const out = [...messages];
  // Never the last message: it is the turn's actual question or the tool result
  // the model is about to reason over.
  for (let i = 0; i < out.length - 1 && total(out) > budget; i++) {
    const m = out[i]!;
    if (m.role !== 'tool') continue;
    if ((m.content ?? '').startsWith('[DROPPED')) continue;
    out[i] = { ...m, content: '[DROPPED: an earlier tool result was removed to stay within the context window. Re-run the tool if you need it again.]' };
  }
  return out;
}
