import { and, gt, isNull, or, sql } from 'drizzle-orm';
import { apiTokens } from '../db/schema';
import { oauthAccessToken } from '../db/auth-schema';

/**
 * The two row-level facts "an AI client is connected" is built from (#817 / #967 / #980 / #1008), in ONE place. `ActivationService`
 * asks them per workspace ("is ANY client connected?"); `AiConnectionsService` asks them per person ("which ones are MINE?"). Two
 * copies of "what counts as live" is how the checklist could say connected while the list says nothing, so both import these.
 */

/**
 * A live (not revoked) personal access token a PERSON minted, or one minted for a configured Agent.
 *
 * Tyron mints an ordinary token for every turn (`origin: 'agent'`, no `agent_id`) and revokes it when the turn ends; counting those
 * would mark a workspace "AI connected" for merely chatting with the in-app assistant. NULL-safe on purpose: an ordinary token has
 * origin NULL, and `NOT (NULL = 'agent' AND ...)` is NULL, which would silently EXCLUDE every normal token; IS DISTINCT FROM treats NULL
 * as "not agent", which is the point.
 */
export const liveAiTokenCondition = () =>
  // #1132 — a per-run credential (runner_id set) is the server's, minted per run for an agent: it is not a connection a person made.
  and(isNull(apiTokens.revokedAt), isNull(apiTokens.runnerId), sql`(${apiTokens.origin} IS DISTINCT FROM 'agent' OR ${apiTokens.agentId} IS NOT NULL)`);

/**
 * An OAuth token that can still be used. There is no revoked flag: revoking deletes the row (and so does erasure), and an access token
 * past its expiry whose refresh token is also past its own can no longer be used, so "a row that has not expired" is exactly "not
 * revoked and still usable".
 */
export const liveOauthTokenCondition = (now: Date = new Date()) =>
  or(gt(oauthAccessToken.refreshTokenExpiresAt, now), gt(oauthAccessToken.accessTokenExpiresAt, now));
