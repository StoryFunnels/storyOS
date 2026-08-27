import { describe, expect, it } from 'vitest';
import { runTurn, type TurnEvent } from './turn-loop';
import type { ChatMessage, ChatReply, ChatToolDef, TyronChatClient } from './chat-client';
import type { TyronTool, TyronToolCatalog, TyronToolResult } from './tool-catalog';
import { ToolsUnreachableError } from './tool-catalog';
import { MAX_TOOL_CALLS_PER_TURN } from './ceilings';

/**
 * #357b. Both seams are faked, so every branch of the loop is provable without a
 * network call — the same reasoning `ManagedAiClient` records for its own seam:
 * "swappable in tests, so the logic is provable without ever making a real
 * network call".
 */

function fakeCatalog(over: Partial<TyronToolCatalog> = {}): TyronToolCatalog & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    list: async (): Promise<TyronTool[]> => [
      { name: 'query_records', description: 'read', inputSchema: { type: 'object' } },
      { name: 'update_record', description: 'write', inputSchema: { type: 'object' } },
      { name: 'delete_record', description: 'delete', inputSchema: { type: 'object' } },
    ],
    call: async (name): Promise<TyronToolResult> => {
      calls.push(name);
      return { text: 'ok', isError: false };
    },
    close: async () => {},
    ...over,
  } as TyronToolCatalog & { calls: string[] };
}

/** A model that replays a fixed script of replies, one per turn. */
function scriptedChat(script: Array<Partial<ChatReply>>): TyronChatClient & { seen: ChatMessage[][] } {
  let i = 0;
  const seen: ChatMessage[][] = [];
  return {
    seen,
    async chat(messages: ChatMessage[], _tools: ChatToolDef[]): Promise<ChatReply> {
      seen.push([...messages]);
      const next = script[Math.min(i++, script.length - 1)] ?? {};
      return { content: '', toolCalls: [], tokensIn: 0, tokensOut: 0, ...next };
    },
  } as TyronChatClient & { seen: ChatMessage[][] };
}

async function collect(gen: AsyncGenerator<TurnEvent, void, undefined>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('a plain answer', () => {
  it('emits the text and finishes', async () => {
    /*
     * #401 — this case USED to be `'You have 12 clients.'` on a turn with zero
     * tool calls, asserting that it went straight through. That is precisely the
     * defect this ticket is about: an ungrounded count delivered as a fact.
     *
     * The sentence was changed rather than the guard weakened. A test that
     * pinned the fabrication in place would have to be broken for the fix to
     * land, and pretending otherwise by exempting it would be worse than either.
     */
    const events = await collect(
      runTurn('what can you do?', {
        chat: scriptedChat([{ content: 'I can read and update records for you.' }]),
        catalog: fakeCatalog(),
        history: [],
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(events[0]).toEqual({ type: 'text', text: 'I can read and update records for you.' });
  });

  it('sends the system prompt and the history ahead of the user message', async () => {
    const chat = scriptedChat([{ content: 'ok' }]);
    await collect(
      runTurn('second question', {
        chat,
        catalog: fakeCatalog(),
        history: [{ role: 'user', content: 'first question' }],
      }),
    );
    const sent = chat.seen[0]!;
    expect(sent[0]!.role).toBe('system');
    expect(sent[1]!.content).toBe('first question');
    expect(sent[2]!.content).toBe('second question');
  });
});

describe('ordinary tool use', () => {
  it('runs the tool, then answers, and never emits a tool trace', async () => {
    const catalog = fakeCatalog();
    const events = await collect(
      runTurn('update the record', {
        chat: scriptedChat([
          { toolCalls: [{ id: '1', name: 'update_record', arguments: { record: 'r1' } }] },
          { content: 'Updated it.' },
        ]),
        catalog,
        history: [],
      }),
    );
    expect(catalog.calls).toEqual(['update_record']);

    /*
     * #357: Tyron streams outcomes and NEVER a tool trace. Asserted as an
     * absence, because that is the requirement — no emitted event may name the
     * tool it called.
     */
    const emitted = JSON.stringify(events.filter((e) => e.type !== 'done'));
    expect(emitted).not.toContain('update_record');
    // #357 — `done` also carries the turn's token usage now, so this asserts the
    // part the test is about rather than pinning the whole event shape.
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      actions: [{ name: 'update_record', arguments: { record: 'r1' } }],
    });
  });

  it('records actions as STRUCTURE for #354 replay, in order', async () => {
    const events = await collect(
      runTurn('do two things', {
        chat: scriptedChat([
          {
            toolCalls: [
              { id: '1', name: 'query_records', arguments: { database: 'crm/clients' } },
              { id: '2', name: 'update_record', arguments: { record: 'r1' } },
            ],
          },
          { content: 'Done.' },
        ]),
        catalog: fakeCatalog(),
        history: [],
      }),
    );
    const done = events.at(-1)!;
    if (done.type !== 'done') throw new Error('unreachable');
    expect(done.actions.map((a) => a.name)).toEqual(['query_records', 'update_record']);
    expect(done.actions[0]!.arguments).toEqual({ database: 'crm/clients' });
  });

  it('hands a tool FAILURE back to the model rather than ending the turn', async () => {
    // A permission denial or a wrong argument is recoverable. Aborting would turn
    // every recoverable mistake into a dead end (#357).
    const chat = scriptedChat([
      { toolCalls: [{ id: '1', name: 'update_record', arguments: {} }] },
      { content: "You don't have access to that one." },
    ]);
    const events = await collect(
      runTurn('update it', {
        chat,
        catalog: fakeCatalog({ call: async () => ({ text: 'Forbidden', isError: true }) }),
        history: [],
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    // The failure text reached the model as a tool result.
    const secondCall = chat.seen[1]!;
    expect(JSON.stringify(secondCall)).toContain('Forbidden');
  });
});

describe('write safety gates the loop', () => {
  it('turns a delete into a QUESTION and applies nothing', async () => {
    const catalog = fakeCatalog();
    const events = await collect(
      runTurn('delete those', {
        chat: scriptedChat([
          { toolCalls: [{ id: '1', name: 'delete_record', arguments: { record_ids: ['a', 'b'] } }] },
        ]),
        catalog,
        history: [],
      }),
    );
    expect(catalog.calls, 'nothing may run before the user answers').toEqual([]);
    const q = events.find((e) => e.type === 'question');
    expect(q).toBeDefined();
    if (q?.type !== 'question') throw new Error('unreachable');
    expect(q.tool).toBe('delete_record');
    expect(q.verdict.message).toContain('2 records');
  });

  /**
   * The batch check is why this is asserted separately: a model can return an
   * allowed write and a delete in ONE reply, and executing the allowed half
   * first would apply changes the user never got to approve alongside the delete.
   */
  it('a gated call blocks the WHOLE batch, not just itself', async () => {
    const catalog = fakeCatalog();
    await collect(
      runTurn('tidy up', {
        chat: scriptedChat([
          {
            toolCalls: [
              { id: '1', name: 'update_record', arguments: { record: 'r1' } },
              { id: '2', name: 'delete_record', arguments: { record_ids: ['x'] } },
            ],
          },
        ]),
        catalog,
        history: [],
      }),
    );
    expect(catalog.calls, 'the allowed write must not slip through beside the delete').toEqual([]);
  });

  /**
   * #357d — the question must carry the CALL, not only the prose.
   *
   * Without it the caller has to reconstruct what to execute from the message
   * text, and "yes" could run something other than what was classified and
   * shown. This is the assertion that keeps the confirm round-trip honest.
   */
  it('carries the exact call awaiting an answer', async () => {
    const events = await collect(
      runTurn('delete those', {
        chat: scriptedChat([
          { toolCalls: [{ id: '1', name: 'delete_record', arguments: { record_ids: ['a', 'b'], database: 'crm/clients' } }] },
        ]),
        catalog: fakeCatalog(),
        history: [],
      }),
    );
    const q = events.find((e) => e.type === 'question');
    if (q?.type !== 'question') throw new Error('unreachable');
    expect(q.call.name).toBe('delete_record');
    expect(q.call.arguments).toEqual({ record_ids: ['a', 'b'], database: 'crm/clients' });
  });

  it('a refusal is spoken plainly and ends the turn', async () => {
    const events = await collect(
      runTurn('invite bob', {
        chat: scriptedChat([{ toolCalls: [{ id: '1', name: 'invite_member', arguments: {} }] }]),
        catalog: fakeCatalog(),
        history: [],
      }),
    );
    expect(events[0]!.type).toBe('text');
    if (events[0]!.type !== 'text') throw new Error('unreachable');
    expect(events[0]!.text).toMatch(/inviting people/i);
    expect(events.at(-1)!.type).toBe('done');
  });
});

describe('ceilings bound the loop', () => {
  it('stops on a runaway and keeps what was applied', async () => {
    // A model that calls a tool forever.
    const chat = scriptedChat([
      { toolCalls: [{ id: 'x', name: 'update_record', arguments: { record: 'r' } }] },
    ]);
    const events = await collect(
      runTurn('loop forever', { chat, catalog: fakeCatalog(), history: [] }),
    );
    const stopped = events.find((e) => e.type === 'stopped');
    expect(stopped, 'a runaway must stop, not spin').toBeDefined();
    if (stopped?.type !== 'stopped') throw new Error('unreachable');
    // Never a silent halt — the message says what happened.
    expect(stopped.stop.message).toBeTruthy();
    expect(stopped.stop.resumable).toBe(false);
  });

  it('does not stop an honest multi-step job', async () => {
    const chat = scriptedChat([
      { toolCalls: [{ id: '1', name: 'query_records', arguments: {} }] },
      { toolCalls: [{ id: '2', name: 'update_record', arguments: { record: 'r' } }] },
      { content: 'Done.' },
    ]);
    const events = await collect(runTurn('two steps', { chat, catalog: fakeCatalog(), history: [] }));
    expect(events.some((e) => e.type === 'stopped')).toBe(false);
    expect(events.at(-1)!.type).toBe('done');
  });

  it('the cap is generous enough for real work', () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBeGreaterThanOrEqual(20);
  });
});

describe('failure reporting', () => {
  it('says the tools are unreachable rather than pretending to work', async () => {
    const events = await collect(
      runTurn('anything', {
        chat: scriptedChat([{ content: 'hi' }]),
        catalog: fakeCatalog({
          list: async () => {
            throw new ToolsUnreachableError(new Error('econnrefused'));
          },
        }),
        history: [],
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('error');
    if (events[0]!.type !== 'error') throw new Error('unreachable');
    expect(events[0]!.text).toMatch(/can't reach my tools/i);
    // Must be explicit that nothing happened, or the user re-runs it.
    expect(events[0]!.text).toMatch(/haven't done anything/i);
  });

  /**
   * #357: on failure it stops and reports what did and did NOT happen — no
   * silent continue, and no surprise rollback of work the user may want to keep.
   */
  it('a mid-job model failure reports the work already applied as KEPT', async () => {
    let n = 0;
    const chat: TyronChatClient = {
      async chat() {
        if (n++ === 0) {
          return {
            content: '',
            toolCalls: [{ id: '1', name: 'update_record', arguments: { record: 'r1' } }],
            tokensIn: 0,
            tokensOut: 0,
          };
        }
        throw new Error('provider exploded');
      },
    };
    const events = await collect(runTurn('do it', { chat, catalog: fakeCatalog(), history: [] }));
    const err = events.at(-1)!;
    expect(err.type).toBe('error');
    if (err.type !== 'error') throw new Error('unreachable');
    expect(err.text).toMatch(/still in place|nothing was undone/i);
    expect(err.text).toContain('1 change');
  });

  it('says nothing was changed when nothing had been', async () => {
    const chat: TyronChatClient = {
      async chat() {
        throw new Error('provider exploded');
      },
    };
    const events = await collect(runTurn('do it', { chat, catalog: fakeCatalog(), history: [] }));
    const err = events.at(-1)!;
    if (err.type !== 'error') throw new Error('unreachable');
    expect(err.text).toMatch(/nothing was changed/i);
  });
});

/**
 * #401 — never guess numbers, always count.
 *
 * The rule lives in the LOOP, not the system prompt. It was in the prompt, the
 * model ignored it, and "There are currently 50 companies listed in the
 * database" reached a user whose real figure was 148.
 */
describe('#401 grounding: a count must have been counted', () => {
  const FABRICATED = 'There are currently 50 companies listed in the database.';

  it('does not deliver a fabricated count — it sends the model back to look', async () => {
    const chat = scriptedChat([
      { content: FABRICATED },
      { content: '', toolCalls: [{ id: '1', name: 'query_records', arguments: {} }] },
      { content: 'There are 148 companies.' },
    ]);
    const catalog = fakeCatalog();
    const events = await collect(runTurn('how many companies do we have', { chat, catalog, history: [] }));

    // The invented number never reaches the user.
    expect(events.some((e) => e.type === 'text' && e.text === FABRICATED)).toBe(false);
    // The model DID go and look, and the real figure is what ships.
    expect(catalog.calls).toEqual(['query_records']);
    expect(events.at(-2)).toEqual({ type: 'text', text: 'There are 148 companies.' });
  });

  it('tells the model plainly what it did wrong', async () => {
    const chat = scriptedChat([{ content: FABRICATED }, { content: 'Which database should I count?' }]);
    await collect(runTurn('how many companies', { chat, catalog: fakeCatalog(), history: [] }));
    const nudge = chat.seen[1]!.at(-1)!;
    expect(nudge.role).toBe('user');
    expect(nudge.content).toContain('without calling any tool');
    // Not a licence to hedge — "roughly 50" would be the same defect, quieter.
    expect(nudge.content).toContain('do not hedge');
  });

  it('asking WHICH database is an acceptable answer, not another offence', async () => {
    const chat = scriptedChat([{ content: FABRICATED }, { content: 'Which database should I count?' }]);
    const events = await collect(runTurn('how many companies', { chat, catalog: fakeCatalog(), history: [] }));
    expect(events.at(-2)).toEqual({ type: 'text', text: 'Which database should I count?' });
  });

  it('replaces a SECOND fabrication with an honest admission', async () => {
    // Twice is not a slip. Shipping the second invention would be worse than the
    // first, because by then the system knows it is one.
    const chat = scriptedChat([{ content: FABRICATED }, { content: 'There are about 50 companies listed.' }]);
    const events = await collect(runTurn('how many companies', { chat, catalog: fakeCatalog(), history: [] }));
    const text = events.find((e) => e.type === 'text') as { text: string };
    expect(text.text).toContain("won't guess");
    expect(text.text).not.toContain('50');
  });

  it('never second-guesses an answer that DID call tools', async () => {
    // A grounded count is the whole point. It must pass through untouched, even
    // though the sentence looks identical to the fabricated one.
    const chat = scriptedChat([
      { content: '', toolCalls: [{ id: '1', name: 'query_records', arguments: {} }] },
      { content: 'There are 148 companies listed in the database.' },
    ]);
    const events = await collect(runTurn('how many companies', { chat, catalog: fakeCatalog(), history: [] }));
    expect(events.at(-2)).toEqual({ type: 'text', text: 'There are 148 companies listed in the database.' });
  });

  it('leaves an ordinary reply containing a number completely alone', async () => {
    // The AC names this one. An over-firing guard makes Tyron hedge everything,
    // which is its own damage (#358).
    const chat = scriptedChat([{ content: 'I can help with 2 things.' }]);
    const events = await collect(runTurn('what can you do', { chat, catalog: fakeCatalog(), history: [] }));
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(events[0]).toEqual({ type: 'text', text: 'I can help with 2 things.' });
    // and it must not have burned a model round trip proving that
    expect(chat.seen).toHaveLength(1);
  });
});

/**
 * #357 — spend per workspace is MEASURED, and nothing is enforced.
 *
 * #353 decided against a ceiling deliberately, so this exists to let a future
 * limit be chosen from data rather than guessed. Tokens rather than cents: a
 * per-model price list does not exist anywhere in this codebase and is a pricing
 * decision, not an engineering one.
 */
describe('#357 turn usage', () => {
  it('reports what the turn cost', async () => {
    const chat = scriptedChat([{ content: 'done', tokensIn: 120, tokensOut: 30 }]);
    const events = await collect(runTurn('hi', { chat, catalog: fakeCatalog(), history: [] }));
    const done = events.at(-1) as { type: 'done'; usage?: { tokensIn: number; tokensOut: number } };
    expect(done.usage).toEqual({ tokensIn: 120, tokensOut: 30 });
  });

  it('SUMS every model call, not just the last one', async () => {
    /*
     * The half a naive implementation gets wrong. A turn that called five tools
     * paid for five round trips, and reporting only the final reply's usage
     * would under-count exactly the expensive turns a future limit would exist
     * to catch.
     */
    const chat = scriptedChat([
      { content: '', toolCalls: [{ id: '1', name: 'query_records', arguments: {} }], tokensIn: 100, tokensOut: 10 },
      { content: 'here it is', tokensIn: 400, tokensOut: 25 },
    ]);
    const events = await collect(runTurn('how many', { chat, catalog: fakeCatalog(), history: [] }));
    const done = events.at(-1) as { type: 'done'; usage?: { tokensIn: number; tokensOut: number } };
    expect(done.usage).toEqual({ tokensIn: 500, tokensOut: 35 });
  });

  it('measures without enforcing — a huge turn still completes', async () => {
    // #353: no spend ceiling. Measurement must never become a gate by accident.
    const chat = scriptedChat([{ content: 'expensive but fine', tokensIn: 5_000_000, tokensOut: 900_000 }]);
    const events = await collect(runTurn('hi', { chat, catalog: fakeCatalog(), history: [] }));
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
  });
});
