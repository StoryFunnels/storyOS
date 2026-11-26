import { betterAuth } from 'better-auth';
import { eq } from 'drizzle-orm';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, mcp } from 'better-auth/plugins';
import { env } from '../config/env';
import type { Db } from '../db/client';
import {
  account,
  session,
  user,
  verification,
  oauthApplication,
  oauthAccessToken,
  oauthConsent,
} from '../db/auth-schema';
import type { EmailService } from '../mail/email.service';
import { inviteTokenVouchesFor } from '../workspaces/invite-token';

/**
 * better-auth instance (docs/architecture/auth.md).
 * - email/password with verification + reset, routed through EmailService
 *   (MN-103 — Resend when configured, SMTP or a log line otherwise)
 * - Google OAuth only when env credentials exist (MN-007)
 * - bearer plugin: session token usable as `Authorization: Bearer` for curl/scripts
 */
export function createAuth(
  db: Db,
  emailService: EmailService,
  /**
   * #419 — called after better-auth updates a `user` row.
   *
   * A callback rather than a service, so this file stays ignorant of the Members
   * projection. It already knows about email and the database because it cannot
   * work without them; it does not need to know why anyone cares that a name
   * changed.
   */
  onUserUpdated?: (userId: string) => void,
) {
  const e = env();
  const googleEnabled = Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);

  return betterAuth({
    baseURL: e.API_URL,
    basePath: '/api/v1/auth',
    secret: e.BETTER_AUTH_SECRET,
    trustedOrigins: [e.WEB_URL],
    /**
     * #419 — a profile edit must reach the Members projection.
     *
     * The avatar routes are ours and emit directly. The display NAME is not:
     * the web app calls better-auth's own `authClient.updateUser({ name })`, so
     * the write never passes through any controller we own and there was nothing
     * to hook. A renamed user's Members row stayed wrong until their next role
     * change or the next API restart — both unrelated to the edit, which made
     * the fix time effectively random.
     *
     * A DATABASE hook rather than routing profile edits through our own API,
     * which was the other option considered. This catches every path, including
     * ones we do not own and ones better-auth adds later — routing would have
     * fixed today's caller and left the next one to rediscover the bug.
     *
     * `after`, so it never blocks or fails the update: the projection is a cache
     * with a backfill, and a rename must not fail because a downstream refresh
     * hiccuped.
     */
    databaseHooks: {
      user: {
        /**
         * Ticket #1347 — an account CREATED THROUGH THE INVITE LINK is born email-verified.
         *
         * The link was mailed to the invited address, so registering that address while holding the link proves the mailbox exactly
         * as a magic link does; accepting an invite then needs a verified address (invites.service accept()) and these people have
         * no reason to be sent through a second email. The web sends the link's token as `invite_token` on the ordinary email
         * sign-up. It counts only when it names a PENDING invite issued to exactly the address being registered; anything else
         * (revoked, expired, used, unknown, malformed, another address) leaves the account unverified and the sign-up's response
         * unchanged, so a sign-up never reveals the state of an invite.
         *
         * This runs only while a NEW user row is being inserted, so it can never upgrade an account that already exists:
         * better-auth refuses a sign-up for a taken address before it gets here. It is limited to the email sign-up route, so
         * social sign-ins and any other way of creating a user are untouched.
         */
        create: {
          before: async (
            created: { email?: string },
            context?: { path?: string; body?: Record<string, unknown> } | null,
          ) => {
            if (context?.path !== '/sign-up/email' || !created?.email) return;
            const vouched = await inviteTokenVouchesFor(db, context.body?.['invite_token'], created.email);
            return vouched ? { data: { emailVerified: true } } : undefined;
          },
        },
        update: {
          after: async (updated: { id?: string }) => {
            if (updated?.id) onUserUpdated?.(updated.id);
          },
        },
      },
    },
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user,
        session,
        account,
        verification,
        oauthApplication,
        oauthAccessToken,
        oauthConsent,
      },
    }),
    emailAndPassword: {
      enabled: true,
      sendResetPassword: async ({ user: u, url }) => {
        await emailService.send({ kind: 'reset-password', to: u.email, url });
      },
      // #1077 — a reset is what someone does after a compromise, so it must end every credential the attacker may hold:
      // all sessions (better-auth deletes them after this hook) and every connected-AI OAuth access + refresh token, which
      // better-auth's mcp plugin knows nothing about here. PATs are deliberately left alone: they are long-lived API keys.
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user: u }) => {
        await db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, u.id));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user: u, url }) => {
        // #1347 — an account created through an invite link is already verified; mailing it a link to do so again is noise.
        // better-auth only calls this for an unverified address on every other path, so this only silences the sign-up case.
        if (u.emailVerified) return;
        await emailService.send({ kind: 'verify-email', to: u.email, url });
      },
    },
    socialProviders: googleEnabled
      ? {
          google: {
            clientId: e.GOOGLE_CLIENT_ID as string,
            clientSecret: e.GOOGLE_CLIENT_SECRET as string,
          },
        }
      : undefined,
    plugins: [
      bearer(),
      // OAuth authorization server for hosted-MCP connectors (MN-154). Gated: needs the
      // oidc tables migrated. PAT auth is unaffected whether this is on or off.
      ...(e.MCP_OAUTH
        ? [
            mcp({
              loginPage: `${e.WEB_URL}/login`,
              oidcConfig: {
                loginPage: `${e.WEB_URL}/login`,
                // #1030 — every authorization stops here until the person decides. better-auth only honours this for a request
                // carrying prompt=consent, which a client controls, so app.setup forces that parameter on every authorize call.
                consentPage: `${e.WEB_URL}/oauth/consent`,
                requirePKCE: true,
                allowDynamicClientRegistration: true,
                // `offline_access` gives Claude/ChatGPT refresh tokens. The
                // dedicated scope prevents an ordinary app OIDC token from
                // being accepted by the MCP API path.
                defaultScope: 'openid profile email offline_access storyos.mcp',
                scopes: ['storyos.mcp'],
                metadata: {
                  scopes_supported: ['openid', 'profile', 'email', 'offline_access', 'storyos.mcp'],
                },
              },
            }),
          ]
        : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

export function enabledProviders(): string[] {
  const e = env();
  const providers = ['email'];
  if (e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET) providers.push('google');
  return providers;
}
