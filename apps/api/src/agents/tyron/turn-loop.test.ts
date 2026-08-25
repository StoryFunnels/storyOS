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
    const events = await collect(
      runTurn('how many clients?', {
        chat: scriptedChat([{ content: 'You have 12 clients.' }]),
        catalog: fakeCatalog(),
        history: [],
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
    expect(events[0]).toEqual({ type: 'text', text: 'You have 12 clients.' });
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
    expect(events.at(-1)).toEqual({
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
