import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/client';
import { tyronMessages, tyronThreads } from '../../db/schema';
import { env } from '../../config/env';
import type { Membership } from '../../workspaces/workspace-access.guard';
import { TokensService } from '../../tokens/tokens.service';
import { TyronThreadsService } from './threads.service';
import { McpToolCatalog } from './tool-catalog';
import { scopeForRole } from '../agent-principal';
import type { Role } from '../../workspaces/workspace-access.guard';
import { defaultTyronChatClient, type ChatMessage } from './chat-client';
import { runTurn, type TurnEvent } from './turn-loop';
import { BUILD_MAX_TOOL_CALLS, BUILD_MAX_TURNS, BUILD_SYSTEM_PROMPT } from './build-workspace';

/** One tool call awaiting the user's yes or no (#357d). */
interface PendingAction {
  name: string;
  arguments: Record<string, unknown>;
  /** The question as it was shown, so the record of what was agreed is exact. */
  message: string;
}

/**
 * One turn, end to end (#357c).
 *
 * Assembles what `runTurn` needs — a scoped token, a catalog, a model client and
 * the thread's history — runs it, and persists the result.
 *
 * **Deliberately NOT streaming.** #357's requirement is "an animation while
 * working, then a plain statement of what changed" — a spinner and a final
 * answer, not token-level streaming. A single request satisfies that exactly and
 * avoids SSE framing, proxy buffering and reconnect logic for no user-visible
 * gain. #363 is where streaming becomes genuinely necessary (a build takes tens
 * of seconds and needs a progress line), and `runTurn` is already an async
 * generator, so that ticket can consume the same loop event-by-event without
 * this file changing shape.
 */
@Injectable()
export class TyronService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: TokensService,
    private readonly threads: TyronThreadsService,
  ) {}

  /**
   * The outcome of a turn, in the shape the panel renders.
   *
   * `actions` is NOT included. #357 forbids surfacing a tool trace, and #359's
   * read path already withholds it — an endpoint that returned it here would
   * reintroduce exactly what both tickets exclude.
   */
  async takeTurn(
    membership: Membership,
    threadId: string,
    message: string,
    /** #363 — a build supplies its own prompt and ceilings; chat uses the defaults. */
    overrides?: { systemPrompt?: string; maxToolCalls?: number; maxTurns?: number },
  ): Promise<{ reply: string; question?: { message: string; tool: string }; stopped?: string }> {
    // Owner-scoped: a 404 here if the thread is not theirs, before anything else.
    await this.threads.get(membership, threadId);

    /**
     * The user's message is persisted BEFORE anything can fail.
     *
     * Found by testing the unconfigured path: the config check used to come
     * first, so a 422 meant the message was never stored — the composer cleared,
     * nothing rendered, and the text the user had just typed was simply gone.
     * They said it; it belongs in the thread whether or not Tyron could answer.
     *
     * It also means a retry has the context, and an unanswered user message is an
     * honest record of what happened rather than a gap.
     */
    await this.threads.appendMessage(membership, threadId, { role: 'user', content: message });

    const chat = defaultTyronChatClient();
    if (!chat) {
      // Unconfigured is a plain, actionable statement — not a 500. Every
      // self-host without a key lands here, and `defaultManagedAiClient` sets
      // the same precedent for its sibling seam.
      throw new UnprocessableEntityException(
        'Tyron is not configured on this instance — an OpenAI API key has not been set.',
      );
    }

    /**
     * A short-lived token scoped to THIS member (ADR-0016 §2).
     *
     * #357d turns WRITES ON, and the ceiling is `scopeForRole` — the same one
     * `AgentPrincipal` applies to any agent run (admin→admin, member→write,
     * guest→read). Tyron can never be handed more than the engine would give any
     * other agent acting for this person, and a guest stays read-only by the
     * ordinary rule rather than by a Tyron-specific one.
     *
     * The read-only floor #357c used is gone because the thing it was protecting
     * against is fixed: a gated call now has a round-trip to answer it, so a
     * delete asks and waits instead of dead-ending.
     */
    const minted = await this.tokens.create(
      membership.userId,
      membership.workspaceId,
      'Tyron (session)',
      scopeForRole(membership.role as Role),
      true,
      /*
       * #357 — every write on this turn is badged `agent`.
       *
       * The ATTRIBUTION stays the member: `created_by`/`updated_by` name the
       * person who asked, because they authorised it and their permissions
       * bounded it. Tyron never appears as an actor and never accumulates a
       * permission surface of its own.
       *
       * "Who did this" and "was this typed or generated" are different
       * questions, and this answers only the second. #390 could not: Tyron mints
       * an ordinary PAT, so its writes arrived looking like any other MCP
       * client's.
       */
      'agent',
    );

    const catalog = new McpToolCatalog(env().TYRON_MCP_URL, minted.token);
    try {
      // History EXCLUDES the message just stored — `runTurn` takes it separately,
      // and passing it in both places would show the model the same turn twice.
      const history = (await this.historyFor(threadId)).slice(0, -1);

      let reply = '';
      let question: { message: string; tool: string } | undefined;
      let pending: PendingAction | null = null;
      let stopped: string | undefined;
      const actions: Array<{ name: string; arguments: Record<string, unknown> }> = [];
      /** #357 — measured, never enforced. See the note on tyron_messages. */
      let usage: { tokensIn: number; tokensOut: number } | undefined;

      for await (const event of runTurn(message, { chat, catalog, history, ...overrides })) {
        applyEvent(event, {
          onText: (t) => {
            // Status lines and the final text both land here; joined so a turn
            // that narrated a step before finishing still reads as one answer.
            reply = reply ? `${reply}\n\n${t}` : t;
          },
          onQuestion: (q, call) => {
            question = q;
            pending = { name: call.name, arguments: call.arguments, message: q.message };
          },
          onStopped: (s) => {
            stopped = s;
          },
          onDone: (a, u) => {
            actions.push(...a);
            usage = u;
          },
        });
      }

      const spoken = question?.message ?? stopped ?? reply;
      await this.threads.appendMessage(membership, threadId, {
        role: 'assistant',
        content: spoken,
        actions,
        // The model comes from env and is never hardcoded (#357), so recording
        // it here makes a tier change visible in the data rather than only in a
        // deploy.
        ...(usage ? { usage: { ...usage, model: env().OPENAI_MODEL } } : {}),
      });
      /*
       * Store the pending call so "yes" executes exactly what was classified and
       * shown. Cleared on every turn that does NOT end in a question, so an
       * unanswered question cannot be resurrected by a later, unrelated message.
       */
      await this.setPending(threadId, pending);
      // #420 — the just-answered turn carries its model too, so the label
      // appears immediately rather than only after the thread is refetched.
      return {
        reply: spoken,
        ...(usage ? { model: env().OPENAI_MODEL } : {}),
        ...(question ? { question } : {}),
        ...(stopped ? { stopped } : {}),
      };
    } finally {
      /*
       * Both cleanups run even when the turn throws. The token is the one that
       * matters: a minted credential that outlives its turn is a permission
       * surface nobody asked for (ADR-0016 §2), so it is revoked on every path.
       */
      await catalog.close();
      await this.tokens.revoke(membership.userId, minted.id).catch(() => {
        /* best effort — a stranded token expires, but must never fail the turn */
      });
    }
  }

  /**
   * Build a workspace from a sentence (#363).
   *
   * Deliberately `takeTurn` with a different prompt and ceiling, not a second
   * executor — a build is the same shape as any multi-step job, and a separate
   * one would mean two places to keep in step on safety, ceilings and
   * attribution.
   *
   * There is no confirmation gate to worry about here: a build only CREATES, and
   * #358 lets creates through untouched. If the model ever proposed a delete
   * mid-build, `runTurn` would stop and ask exactly as it does anywhere else —
   * which is the right behaviour and needs no special case.
   */
  async buildWorkspace(
    membership: Membership,
    threadId: string,
    description: string,
  ): Promise<{ reply: string }> {
    const result = await this.takeTurn(membership, threadId, description, {
      systemPrompt: BUILD_SYSTEM_PROMPT,
      maxToolCalls: BUILD_MAX_TOOL_CALLS,
      maxTurns: BUILD_MAX_TURNS,
    });
    return { reply: result.reply };
  }

  /** Store or clear the outstanding question. */
  private async setPending(threadId: string, pending: PendingAction | null): Promise<void> {
    await this.db
      .update(tyronThreads)
      .set({ pendingAction: pending })
      .where(eq(tyronThreads.id, threadId));
  }

  /**
   * Answer the outstanding question (#357d / #358).
   *
   * This is what makes a confirmation real rather than decorative. Without it a
   * delete ends the turn as a question nobody can answer, which is why writes
   * were floored at read-only until now.
   *
   * On YES the stored call is executed EXACTLY as classified — the client sends
   * only a boolean, so it cannot answer a different question than the one it was
   * asked. On NO nothing runs, and Tyron says so.
   */
  async confirmPending(
    membership: Membership,
    threadId: string,
    approve: boolean,
  ): Promise<{ reply: string }> {
    const thread = await this.threads.get(membership, threadId);
    const row = await this.db.query.tyronThreads.findFirst({
      where: eq(tyronThreads.id, thread.id),
      columns: { pendingAction: true },
    });
    const pending = row?.pendingAction as PendingAction | null | undefined;
    if (!pending) {
      // Not an error: the likeliest cause is a second click, or a question
      // already answered in another tab. Saying so plainly beats a 4xx.
      return { reply: "There's nothing waiting for an answer." };
    }

    // Cleared FIRST, so a double-click cannot execute a destructive action twice.
    // Losing the pending action on a failure is the safe direction: the user can
    // ask again, whereas running a delete twice cannot be taken back.
    await this.setPending(thread.id, null);

    if (!approve) {
      const declined = "Okay — I haven't done it.";
      await this.threads.appendMessage(membership, threadId, { role: 'assistant', content: declined });
      return { reply: declined };
    }

    const minted = await this.tokens.create(
      membership.userId,
      membership.workspaceId,
      'Tyron (confirm)',
      scopeForRole(membership.role as Role),
      true,
      /*
       * #357 — every write on this turn is badged `agent`.
       *
       * The ATTRIBUTION stays the member: `created_by`/`updated_by` name the
       * person who asked, because they authorised it and their permissions
       * bounded it. Tyron never appears as an actor and never accumulates a
       * permission surface of its own.
       *
       * "Who did this" and "was this typed or generated" are different
       * questions, and this answers only the second. #390 could not: Tyron mints
       * an ordinary PAT, so its writes arrived looking like any other MCP
       * client's.
       */
      'agent',
    );
    const catalog = new McpToolCatalog(env().TYRON_MCP_URL, minted.token);
    try {
      const result = await catalog.call(pending.name, pending.arguments);
      /*
       * The tool's own words on failure — a permission denial explains itself far
       * better than "that didn't work", and this is the path where the user has
       * just explicitly authorised something, so a vague failure is worst here.
       */
      const reply = result.isError ? `That didn't go through: ${result.text}` : 'Done.';
      await this.threads.appendMessage(membership, threadId, {
        role: 'assistant',
        content: reply,
        // Recorded for #354 replay only if it actually ran.
        actions: result.isError ? [] : [{ name: pending.name, arguments: pending.arguments }],
      });
      return { reply };
    } finally {
      await catalog.close();
      await this.tokens.revoke(membership.userId, minted.id).catch(() => {});
    }
  }

  /**
   * The thread's prior turns, in the model's shape.
   *
   * Tool calls are NOT replayed. The stored `actions` are a record of what was
   * done, not a transcript the model needs — feeding them back would grow every
   * prompt with machinery the model does not have to re-reason about, and #357's
   * "no tool trace" rule applies to the model's own context too.
   */
  private async historyFor(threadId: string): Promise<ChatMessage[]> {
    const rows = await this.db.query.tyronMessages.findMany({
      where: and(eq(tyronMessages.threadId, threadId)),
      orderBy: [asc(tyronMessages.createdAt)],
    });
    return rows
      .filter((r) => r.role === 'user' || r.role === 'assistant')
      .map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content }));
  }
}

/**
 * Fold one loop event into the accumulating outcome.
 *
 * Extracted so the exhaustive `switch` is in one place: a new `TurnEvent` variant
 * makes this fail to compile rather than being silently dropped, which is the
 * whole reason the event type is a discriminated union.
 */
function applyEvent(
  event: TurnEvent,
  on: {
    onText: (t: string) => void;
    onQuestion: (q: { message: string; tool: string }, call: { name: string; arguments: Record<string, unknown> }) => void;
    onStopped: (s: string) => void;
    onDone: (
      a: Array<{ name: string; arguments: Record<string, unknown> }>,
      usage?: { tokensIn: number; tokensOut: number },
    ) => void;
  },
): void {
  switch (event.type) {
    case 'text':
    case 'status':
      on.onText(event.text);
      return;
    case 'question':
      on.onQuestion({ message: event.verdict.message, tool: event.tool }, event.call);
      return;
    case 'stopped':
      on.onStopped(event.stop.message);
      return;
    case 'error':
      on.onText(event.text);
      return;
    case 'done':
      on.onDone(event.actions, event.usage);
      return;
  }
}
