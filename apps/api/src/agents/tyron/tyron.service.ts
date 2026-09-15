import { Inject, Injectable, OnModuleInit, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq, ne } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/client';
import { memberships, tyronMessages, tyronThreads } from '../../db/schema';
import { env } from '../../config/env';
import type { Membership } from '../../workspaces/workspace-access.guard';
import { TokensService } from '../../tokens/tokens.service';
import { TyronThreadsService } from './threads.service';
import { TyronSpendGuardService } from './tyron-spend-guard.service';
import { TyronChatClientResolver } from './tyron-chat-client-resolver';
import { McpToolCatalog } from './tool-catalog';
import { scopeForRole } from '../agent-principal';
import type { Role } from '../../workspaces/workspace-access.guard';
import type { ChatMessage } from './chat-client';
import { runTurn, type TurnEvent } from './turn-loop';
import { BUILD_MAX_TOOL_CALLS, BUILD_MAX_TURNS, BUILD_SYSTEM_PROMPT } from './build-workspace';
import { ApprovalsService, type TyronToolCallSnapshot } from '../../automations/approvals.service';
import { JobRunnerService } from '../../automations/job-runner.service';

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
export class TyronService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokens: TokensService,
    private readonly threads: TyronThreadsService,
    private readonly spendGuard: TyronSpendGuardService,
    private readonly chatClientResolver: TyronChatClientResolver,
    /** #542 — an `approval_gate` verdict creates a real row here instead of
     * a same-user yes/no; AgentsModule already imports AutomationsModule, so
     * this needs no new module wiring. */
    private readonly approvals: ApprovalsService,
    private readonly jobs: JobRunnerService,
  ) {}

  /**
   * #542 — registers the `tyron_tool_call` job kind, the same registration
   * pattern MN-256/257/258/259/263's provider modules use to add themselves
   * to the queue without a circular import. Applying an approved outward
   * call is genuinely asynchronous work (the member has already left the
   * turn that asked; nothing is waiting on this synchronously the way an
   * agent-run approval's apply is), so the durable queue is the right fit
   * here — unlike the agent-run gate (#603), which deliberately stayed
   * synchronous for exactly the opposite reason.
   */
  onModuleInit(): void {
    this.jobs.registerExecutor('tyron_tool_call', async (payload) => {
      const { action } = payload as { action: TyronToolCallSnapshot };
      await this.applyApprovedToolCall(action);
    });
  }

  /**
   * Apply an approved outward tool call, minting a token for the ORIGINAL
   * member — never the approving admin — so attribution and effective scope
   * both stay exactly what they would have been had the member's own turn
   * executed it directly. Scope is re-derived from the member's CURRENT
   * role, not whatever it was at staging time — the same
   * never-trust-a-stale-principal rule #603's demotion fix applies to the
   * agent-run gate.
   */
  private async applyApprovedToolCall(action: TyronToolCallSnapshot): Promise<void> {
    const workspaceId = (
      await this.db.query.tyronThreads.findFirst({
        where: eq(tyronThreads.id, action.thread_id),
        columns: { workspaceId: true },
      })
    )?.workspaceId;
    const member = workspaceId
      ? await this.db.query.memberships.findFirst({
          where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, action.member_user_id)),
        })
      : undefined;
    if (!workspaceId || !member) {
      // The thread or the membership is gone (workspace left, member
      // removed) between staging and approval — nothing safe to apply.
      await this.db.insert(tyronMessages).values({
        threadId: action.thread_id,
        role: 'assistant',
        content: `${action.message}\n\nThis was approved, but I can no longer find who asked for it, so I didn't run it.`,
      });
      return;
    }
    const minted = await this.tokens.create(
      action.member_user_id,
      workspaceId,
      'Tyron (approved)',
      scopeForRole(member.role as Role),
      true,
      'agent',
    );
    const catalog = new McpToolCatalog(env().TYRON_MCP_URL, minted.token);
    try {
      const result = await catalog.call(action.tool, action.arguments);
      const content = result.isError
        ? `${action.message}\n\nApproved, but it didn't go through: ${result.text}`
        : `${action.message}\n\nApproved — done.`;
      await this.db.insert(tyronMessages).values({
        threadId: action.thread_id,
        role: 'assistant',
        content,
        actions: result.isError ? [] : [{ name: action.tool, arguments: action.arguments }],
      });
    } finally {
      await catalog.close();
      await this.tokens.revoke(action.member_user_id, minted.id).catch(() => {});
    }
  }

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
  ): Promise<{
    reply: string;
    model?: string;
    source?: 'byo' | 'managed';
    question?: { message: string; tool: string };
    stopped?: string;
  }> {
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

    /**
     * #352 — the workspace's own connected `openai` credential if one
     * exists and is active, else this instance's managed key. Resolved
     * ONCE per turn so `resolved.model`/`resolved.source` stay consistent
     * across everything below that records or reports them.
     */
    const resolved = await this.chatClientResolver.resolve(membership.workspaceId);
    if (!resolved) {
      // Unconfigured is a plain, actionable statement — not a 500. Every
      // self-host without a key (and no workspace connection either) lands
      // here, and `defaultManagedAiClient` sets the same precedent for its
      // sibling seam.
      throw new UnprocessableEntityException(
        'Tyron is not configured on this instance — an OpenAI API key has not been set.',
      );
    }
    const { client: chat, model: resolvedModel, source } = resolved;

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
      let question: { message: string; tool: string; kind: 'confirm' | 'approval_gate' } | undefined;
      let questionCall: { name: string; arguments: Record<string, unknown> } | undefined;
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
            questionCall = call;
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

      /**
       * #542 — `confirm` and `approval_gate` fork here. `confirm` is the
       * SAME chat user answering their own yes/no, exactly as before
       * (`pending`, resolved by `confirmPending`). `approval_gate` is
       * outward-facing — send-something-outside-the-workspace scale — and
       * must not be answerable by the same person who asked; it becomes a
       * real row in the shared `approvals` table, decided by a DIFFERENT
       * workspace admin, the same self-approval boundary the MCP layer
       * already enforces for approve/reject (tools.ts's own "removes the
       * gate, not weakens it" comment).
       */
      if (question?.kind === 'approval_gate' && questionCall) {
        const approverId = await this.pickOtherAdmin(membership.workspaceId, membership.userId);
        if (!approverId) {
          question = {
            ...question,
            message:
              `${question.message} I can't ask anyone else to approve this — you're the only admin in this ` +
              `workspace, and this class of action can't be self-approved. Add a second admin, or do this yourself outside Tyron.`,
          };
        } else {
          await this.approvals.createRow({
            workspaceId: membership.workspaceId,
            // #542 — see TyronToolCallSnapshot's own doc: no database this
            // call is naturally scoped to, so the workspace id stands in.
            databaseId: membership.workspaceId,
            ruleId: null,
            runId: null,
            recordId: null,
            actionIndex: 0,
            action: {
              type: 'tyron_tool_call',
              thread_id: threadId,
              member_user_id: membership.userId,
              tool: questionCall.name,
              arguments: questionCall.arguments,
              message: question.message,
            },
            previewText: question.message,
            requesterActorId: approverId,
            notification: {
              type: 'approval_requested',
              snippet: `Tyron wants to ${question.message}`,
            },
          });
          question = {
            ...question,
            message: `${question.message} I've sent this to a workspace admin to approve — I'll let you know what they decide.`,
          };
        }
      } else if (question?.kind === 'confirm' && questionCall) {
        pending = { name: questionCall.name, arguments: questionCall.arguments, message: question.message };
      }

      const spoken = question?.message ?? stopped ?? reply;
      await this.threads.appendMessage(membership, threadId, {
        role: 'assistant',
        content: spoken,
        actions,
        // The model comes from `resolved` (env for managed, the connection's
        // own config for BYO) and is never hardcoded (#357), so recording it
        // here makes both a tier change AND a BYO switch visible in the data
        // rather than only in a deploy or a connections-page click.
        ...(usage ? { usage: { ...usage, model: resolvedModel, source } } : {}),
      });
      // #353 — measured, never enforced (see the service's own doc). ONLY for
      // a managed-key turn: #352's AC is explicit that a workspace's own key
      // carries no StoryOS usage limit or meter, and tracking someone else's
      // OpenAI spend toward OUR anomaly guard would answer a question nobody
      // is asking (it isn't a bill we'd ever see). Never awaited into the
      // response path either way — a broken spend guard must not break a
      // real turn, same convention as every other fire-and-forget side
      // effect here.
      if (usage && source === 'managed') {
        void this.spendGuard
          .recordUsage(membership.workspaceId, usage.tokensIn, usage.tokensOut)
          .catch(() => undefined);
      }
      /*
       * Store the pending call so "yes" executes exactly what was classified and
       * shown. Cleared on every turn that does NOT end in a question, so an
       * unanswered question cannot be resurrected by a later, unrelated message.
       */
      await this.setPending(threadId, pending);
      // #420 — the just-answered turn carries its model too, so the label
      // appears immediately rather than only after the thread is refetched.
      // #352 — `source` alongside it, so the composer can say WHICH AI
      // answered rather than inferring it from a model name that could
      // coincidentally match between a workspace's own key and StoryOS's.
      return {
        reply: spoken,
        ...(usage ? { model: resolvedModel, source } : {}),
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

  /**
   * #542 — a workspace admin OTHER than `excludeUserId`, for an
   * `approval_gate` verdict's approver. Self-approval would make the gate
   * decorative in exactly the way this ticket exists to stop — the same
   * boundary packages/mcp/src/tools.ts already enforces for agent-run
   * approve/reject. Returns undefined when the excluded user is the only
   * admin, which the caller treats as "refuse the action" rather than
   * silently picking them anyway or leaving the gate unresolvable forever.
   */
  private async pickOtherAdmin(workspaceId: string, excludeUserId: string): Promise<string | undefined> {
    const other = await this.db.query.memberships.findFirst({
      where: and(
        eq(memberships.workspaceId, workspaceId),
        eq(memberships.role, 'admin'),
        ne(memberships.userId, excludeUserId),
      ),
    });
    return other?.userId;
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
    onQuestion: (
      q: { message: string; tool: string; kind: 'confirm' | 'approval_gate' },
      call: { name: string; arguments: Record<string, unknown> },
    ) => void;
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
      on.onQuestion({ message: event.verdict.message, tool: event.tool, kind: event.verdict.kind }, event.call);
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
