import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DB } from '../../db/db.module';
import type { Db } from '../../db/client';
import { connections } from '../../db/schema';
import { ConnectionsService } from '../../connections/connections.service';
import type { OpenAiConnectionAuth } from '../../connections/providers';
import { env } from '../../config/env';
import { OpenAiTyronChatClient, defaultTyronChatClient } from './chat-client';
import type { TyronChatClient } from './chat-client';

export interface ResolvedTyronChat {
  client: TyronChatClient;
  model: string;
  /**
   * #352 — 'byo' when this came from the workspace's OWN connected OpenAI
   * credential, 'managed' when it fell back to StoryOS's env-configured key.
   * Stamped onto the turn (tyron_messages.source) so "which AI answered" is
   * never left to be inferred from the model name alone.
   */
  source: 'byo' | 'managed';
}

/**
 * #352 — resolves which chat client a Tyron turn should run on: the
 * workspace's own connected `openai` connection if one exists and is
 * active, else the fall back to the env-configured managed client
 * (`defaultTyronChatClient`, unchanged from before this ticket).
 *
 * v1 scope, deliberately narrower than "a provider descriptor plus a
 * per-workspace default and a per-thread override": this resolves a
 * per-WORKSPACE default only — every thread in a workspace with a
 * connected key uses it. A per-thread override is real, separate UI/API
 * surface the ticket's own text only speculates about ("likely"), not
 * something its AC bullets actually require — building it here would be
 * scope the ticket never asked for.
 *
 * "Most recent active" rather than a designated pointer: a workspace
 * connecting a second `openai` credential is an edge case the ticket's AC
 * doesn't ask to be resolved by an explicit picker, and adding one now
 * would be new schema for a problem nobody has hit yet — the same
 * reasoning `AiFieldSubscriber` and other v1 scope cuts this backlog has
 * made apply here.
 */
@Injectable()
export class TyronChatClientResolver {
  /** Swappable in tests — same seam as ConnectionsService.fetcher /
   * smtpProvider.buildTransport, so the managed-fallback branch is testable
   * without depending on `env()`'s process-wide, cache-once-on-first-call
   * OPENAI_API_KEY (mutating process.env mid-test-run does not reach a
   * value `env()` already cached). */
  resolveManagedClient: () => TyronChatClient | undefined = defaultTyronChatClient;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly connectionsService: ConnectionsService,
  ) {}

  async resolve(workspaceId: string): Promise<ResolvedTyronChat | undefined> {
    const row = await this.db.query.connections.findFirst({
      where: and(
        eq(connections.workspaceId, workspaceId),
        eq(connections.provider, 'openai'),
        eq(connections.status, 'active'),
      ),
      orderBy: [desc(connections.createdAt)],
    });
    if (row) {
      const { auth } = await this.connectionsService.getDecryptedAuth(workspaceId, row.id);
      const { api_key, model } = (auth ?? {}) as Partial<OpenAiConnectionAuth>;
      if (api_key) {
        const resolvedModel = model?.trim() || env().OPENAI_MODEL;
        return { client: new OpenAiTyronChatClient(api_key, resolvedModel), model: resolvedModel, source: 'byo' };
      }
    }
    const managed = this.resolveManagedClient();
    if (!managed) return undefined;
    return { client: managed, model: env().OPENAI_MODEL, source: 'managed' };
  }
}
