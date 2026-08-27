import { describe, expect, it } from 'vitest';
import {
  MAX_HISTORY_TOKENS,
  MAX_TOOL_RESULT_CHARS,
  capToolResult,
  estimateTokens,
  trimHistory,
} from './context-budget';

/**
 * #404 — a turn must stay inside the window whatever the data does.
 *
 * The production failure: `136922 tokens (130334 in the messages)` against a
 * 128,000-token window, from the question "how many contacts do we have?".
 *
 * The assertions that matter most are the ones about MARKERS. Bounding the
 * context is easy; bounding it without letting the model believe it still has
 * the data is the part that keeps #401 fixed.
 */
describe('#404 tool-result cap', () => {
  it('leaves a normal result completely alone', () => {
    const small = 'Found 3 records.';
    expect(capToolResult(small)).toBe(small);
  });

  it('truncates a table-sized result', () => {
    const huge = 'x'.repeat(MAX_TOOL_RESULT_CHARS * 3);
    expect(capToolResult(huge).length).toBeLessThan(huge.length);
  });

  it('SAYS it truncated, in the text the model reads', () => {
    // Silent truncation is worse than the crash it prevents: the model would get
    // twenty rows of a hundred and answer as though it had them all.
    const out = capToolResult('y'.repeat(MAX_TOOL_RESULT_CHARS + 1));
    expect(out).toContain('TRUNCATED');
    expect(out).toContain('NOT seeing the whole set');
    // and it must point at the right alternative, or the model just re-queries
    expect(out).toMatch(/aggregate|count/);
  });

  it('tells the model not to count from a clipped set', () => {
    // This is #401's rule arriving through #404's door.
    const out = capToolResult('z'.repeat(MAX_TOOL_RESULT_CHARS + 1));
    expect(out).toContain('Do not count');
  });

  it('keeps the beginning, not the end', () => {
    // The head of a result carries the schema/labels; the tail is more rows.
    const out = capToolResult('HEADER' + 'q'.repeat(MAX_TOOL_RESULT_CHARS));
    expect(out.startsWith('HEADER')).toBe(true);
  });
});

describe('#404 history trimming', () => {
  const tool = (n: number) => ({ role: 'tool' as const, content: 'r'.repeat(n) });
  const prose = (text: string) => ({ role: 'assistant' as const, content: text });

  it('does nothing to a conversation that already fits', () => {
    const msgs = [prose('hi'), tool(100), prose('done')];
    expect(trimHistory(msgs)).toEqual(msgs);
  });

  it('drops the OLDEST tool results first', () => {
    const big = MAX_HISTORY_TOKENS * 4; // chars ≈ 4x tokens
    const msgs = [tool(big), tool(big), prose('the answer so far'), prose('next question')];
    const out = trimHistory(msgs);
    expect(out[0]!.content).toContain('DROPPED');
  });

  it('NEVER drops prose — the thread lives there, not in the rows', () => {
    const big = MAX_HISTORY_TOKENS * 4;
    const msgs = [prose('the user asked about churn'), tool(big), tool(big), prose('last')];
    const out = trimHistory(msgs);
    expect(out[0]!.content).toBe('the user asked about churn');
    expect(out.at(-1)!.content).toBe('last');
  });

  it('never drops the LAST message, even if it is the huge one', () => {
    // It is the result the model is about to reason over, or the actual question.
    const msgs = [prose('q'), tool(MAX_HISTORY_TOKENS * 8)];
    const out = trimHistory(msgs);
    expect(out.at(-1)!.content).not.toContain('DROPPED');
  });

  it('marks what it dropped rather than removing it silently', () => {
    const big = MAX_HISTORY_TOKENS * 4;
    const out = trimHistory([tool(big), tool(big), prose('x')]);
    const dropped = out.find((m) => m.content.includes('DROPPED'))!;
    expect(dropped.content).toContain('Re-run the tool');
    // The message stays in place, so the tool-call/result pairing is not broken.
    expect(out).toHaveLength(3);
  });

  it('does not re-mark an already-dropped message', () => {
    const big = MAX_HISTORY_TOKENS * 4;
    const once = trimHistory([tool(big), tool(big), prose('x')]);
    const twice = trimHistory(once);
    expect(twice.filter((m) => m.content.includes('DROPPED')).length).toBe(
      once.filter((m) => m.content.includes('DROPPED')).length,
    );
  });
});

describe('#404 token estimate', () => {
  it('rounds UP, so the budget errs toward trimming early', () => {
    // Being wrong here should cost a slightly early trim, never a failed turn.
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('a'.repeat(4001))).toBe(1001);
  });

  it('handles an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });
});
