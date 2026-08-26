import { Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/client';
import { tyronMessages } from '../../db/schema';
import { env } from '../../config/env';
import type { Membership } from '../../workspaces/workspace-access.guard';
import { TokensService } from '../../tokens/tokens.service';
import { TyronThreadsService } from './threads.service';
import { McpToolCatalog, TYRON_READ_ONLY_SCOPE } from './tool-catalog';
import { defaultTyronChatClient, type ChatMessage } from './chat-client';
import { runTurn, type TurnEvent } from './turn-loop';

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
     * #357c stays READ-ONLY, so the scope is the constant rather than the member's
     * own ceiling. Not caution for its own sake: `runTurn` already consults #358's
     * classifier, but a gated call ends the turn as a QUESTION and there is no
     * round-trip yet to answer it. Enabling writes now would let ordinary writes
     * through while every delete dead-ended — worse than read-only, because it
     * would look like it worked.
     *
     * When that round-trip lands, this becomes `scopeForRole(membership.role)` —
     * the same ceiling `AgentPrincipal` applies to any agent run (admin→admin,
     * member→write, guest→read), so Tyron can never be handed more than the
     * engine would give any other agent acting for this person.
     */
    const minted = await this.tokens.create(
      membership.userId,
      membership.workspaceId,
      'Tyron (session)',
      TYRON_READ_ONLY_SCOPE,
    );

    const catalog = new McpToolCatalog(env().TYRON_MCP_URL, minted.token);
    try {
      // History EXCLUDES the message just stored — `runTurn` takes it separately,
      // and passing it in both places would show the model the same turn twice.
      const history = (await this.historyFor(threadId)).slice(0, -1);

      let reply = '';
      let question: { message: string; tool: string } | undefined;
      let stopped: string | undefined;
      const actions: Array<{ name: string; arguments: Record<string, unknown> }> = [];

      for await (const event of runTurn(message, { chat, catalog, history })) {
        applyEvent(event, {
          onText: (t) => {
            // Status lines and the final text both land here; joined so a turn
            // that narrated a step before finishing still reads as one answer.
            reply = reply ? `${reply}\n\n${t}` : t;
          },
          onQuestion: (q) => {
            question = q;
          },
          onStopped: (s) => {
            stopped = s;
          },
          onDone: (a) => {
            actions.push(...a);
          },
        });
      }

      const spoken = question?.message ?? stopped ?? reply;
      await this.threads.appendMessage(membership, threadId, {
        role: 'assistant',
        content: spoken,
        actions,
      });
      return { reply: spoken, ...(question ? { question } : {}), ...(stopped ? { stopped } : {}) };
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
    onQuestion: (q: { message: string; tool: string }) => void;
    onStopped: (s: string) => void;
    onDone: (a: Array<{ name: string; arguments: Record<string, unknown> }>) => void;
  },
): void {
  switch (event.type) {
    case 'text':
    case 'status':
      on.onText(event.text);
      return;
    case 'question':
      on.onQuestion({ message: event.verdict.message, tool: event.tool });
      return;
    case 'stopped':
      on.onStopped(event.stop.message);
      return;
    case 'error':
      on.onText(event.text);
      return;
    case 'done':
      on.onDone(event.actions);
      return;
  }
}
