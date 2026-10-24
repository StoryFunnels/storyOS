import { randomUUID } from 'node:crypto';
import { GoneException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { memberships, workspaces } from '../db/schema';
import { oauthApplication, oauthConsent, verification } from '../db/auth-schema';
import { formatGrantScopes, SCOPE_LABELS } from './oauth-grant';
import type { OauthGrant } from './oauth-grant';

/** What better-auth's mcp plugin stored under the authorization code (authorize.mjs); only the fields used here. */
interface PendingAuthorization {
  clientId: string;
  redirectURI: string;
  scope: string[];
  userId: string;
  state?: string | null;
  requireConsent?: boolean;
  /** Set by decide(): a code is single-decision. */
  decided?: 'allow' | 'deny';
}

/**
 * #1030 — the consent step of the hosted-MCP authorization-code flow. better-auth's mcp plugin ships NO consent endpoint (the
 * oidc-provider plugin's `/oauth2/consent` is a different plugin), so the two calls the consent page needs live here:
 * describe what is being asked, and record the person's decision.
 *
 * The `consent_code` IS the authorization code better-auth minted for this request. It is shown to nobody but the browser the
 * authorize call redirected, it is only usable by the user it was issued to, and it becomes a working code at the client only
 * when `decide('allow')` hands it back through the redirect. A deny deletes it.
 */
@Injectable()
export class OauthConsentService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** The pending request for THIS person, or 404/410. Someone else's code answers exactly like an unknown one. */
  private async pending(userId: string, code: string) {
    const [row] = await this.db.select().from(verification).where(eq(verification.identifier, code)).limit(1);
    if (!row) throw new NotFoundException('This authorization request was not found');
    let value: PendingAuthorization;
    try {
      value = JSON.parse(row.value) as PendingAuthorization;
    } catch {
      throw new NotFoundException('This authorization request was not found');
    }
    if (value.userId !== userId || !value.clientId || !value.redirectURI) throw new NotFoundException('This authorization request was not found');
    if (row.expiresAt.getTime() < Date.now()) throw new GoneException('This authorization request has expired. Start the connection again from the AI client.');
    if (value.decided) throw new GoneException('This authorization request was already answered.');
    return { row, value };
  }

  private async clientOf(clientId: string) {
    const [client] = await this.db.select().from(oauthApplication).where(eq(oauthApplication.clientId, clientId)).limit(1);
    if (!client || client.disabled) throw new NotFoundException('This authorization request was not found');
    return client;
  }

  async describe(userId: string, code: string) {
    const { value } = await this.pending(userId, code);
    const client = await this.clientOf(value.clientId);
    const mine = await this.db.query.memberships.findMany({
      where: and(eq(memberships.userId, userId), eq(memberships.status, 'active')),
    });
    const wss = mine.length
      ? await this.db.select({ id: workspaces.id, name: workspaces.name }).from(workspaces).where(inArray(workspaces.id, mine.map((m) => m.workspaceId))).orderBy(asc(workspaces.name))
      : [];
    return {
      client_name: client.name?.trim() || 'Unnamed client',
      // The host the code will be sent to: the one fact a person can check against what they expect to be connecting.
      redirect_host: new URL(value.redirectURI).host,
      scopes: value.scope.map((id) => ({ id, label: SCOPE_LABELS[id] ?? id })),
      workspaces: wss,
      access_options: ['read', 'write'] as const,
    };
  }

  /** Allow (bind to one workspace and a power ceiling) or deny. Returns where the browser goes next: the client's redirect URI. */
  async decide(
    userId: string,
    input: { consent_code: string; decision: 'allow' | 'deny'; workspace_id?: string; access?: 'read' | 'write' },
  ): Promise<{ redirect_url: string }> {
    const { row, value } = await this.pending(userId, input.consent_code);
    await this.clientOf(value.clientId);
    const target = new URL(value.redirectURI);

    if (input.decision === 'deny') {
      await this.db.delete(verification).where(eq(verification.id, row.id));
      target.searchParams.set('error', 'access_denied');
      if (value.state) target.searchParams.set('state', value.state);
      return { redirect_url: target.toString() };
    }

    if (!input.workspace_id) throw new UnprocessableEntityException('Choose the workspace this client may reach');
    const member = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.userId, userId), eq(memberships.workspaceId, input.workspace_id), eq(memberships.status, 'active')),
    });
    // The same answer as a workspace that does not exist: nothing here confirms it.
    if (!member) throw new NotFoundException('Workspace not found');
    const grant: OauthGrant = { workspaceId: input.workspace_id.toLowerCase(), access: input.access === 'write' ? 'write' : 'read' };

    await this.db.transaction(async (tx) => {
      // One live grant per person and client: allowing again REPLACES what was allowed before, never widens it silently.
      await tx.delete(oauthConsent).where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, value.clientId)));
      await tx.insert(oauthConsent).values({
        id: randomUUID(),
        clientId: value.clientId,
        userId,
        scopes: formatGrantScopes(value.scope, grant),
        consentGiven: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await tx
        .update(verification)
        .set({ value: JSON.stringify({ ...value, decided: 'allow' satisfies PendingAuthorization['decided'] }), updatedAt: new Date() })
        .where(eq(verification.id, row.id));
    });
    target.searchParams.set('code', input.consent_code);
    if (value.state) target.searchParams.set('state', value.state);
    return { redirect_url: target.toString() };
  }
}
