import { betterAuth } from 'better-auth';
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

/**
 * better-auth instance (docs/architecture/auth.md).
 * - email/password with verification + reset, routed through EmailService
 *   (MN-103 — Resend when configured, SMTP or a log line otherwise)
 * - Google OAuth only when env credentials exist (MN-007)
 * - bearer plugin: session token usable as `Authorization: Bearer` for curl/scripts
 */
export function createAuth(db: Db, emailService: EmailService) {
  const e = env();
  const googleEnabled = Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET);

  return betterAuth({
    baseURL: e.API_URL,
    basePath: '/api/v1/auth',
    secret: e.BETTER_AUTH_SECRET,
    trustedOrigins: [e.WEB_URL],
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
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user: u, url }) => {
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
