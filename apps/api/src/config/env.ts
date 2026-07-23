import { hkdfSync, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * The value BETTER_AUTH_SECRET used to default to in this file. It is public in
 * this repo's history, so any production instance signing sessions with it can
 * have *any* user's session cookie forged — full account takeover, no exploit
 * skill required. Production must refuse to boot with it. (MN-231 / MN-232)
 */
export const LEGACY_DEFAULT_AUTH_SECRET =
  'storyos-dev-secret-change-in-production';

/**
 * Resolve BETTER_AUTH_SECRET, or refuse to boot. In production the secret must
 * be explicitly set to a value that is neither the well-known legacy default nor
 * obviously too short to be a generated key. Outside production an unset secret
 * becomes a random per-boot value — never a shared constant baked into source,
 * because a committed default is exactly the vulnerability above.
 */
export function resolveAuthSecret(
  nodeEnv: 'development' | 'test' | 'production',
  provided: string | undefined,
): string {
  const value = provided?.trim();
  if (nodeEnv === 'production') {
    const weak =
      !value || value === LEGACY_DEFAULT_AUTH_SECRET || value.length < 16;
    if (weak) {
      throw new Error(
        [
          'FATAL: refusing to boot in production with an unsafe BETTER_AUTH_SECRET.',
          value
            ? 'The value is the well-known default or too short to be a real key.'
            : 'BETTER_AUTH_SECRET is not set.',
          'Sessions are signed with this key: a public or guessable value lets anyone',
          'forge a login for any user. Set a strong, unique secret before starting:',
          '',
          '    BETTER_AUTH_SECRET=$(openssl rand -hex 32)',
          '',
        ].join('\n'),
      );
    }
    return value;
  }
  // development / test: no sessions worth preserving across restarts, so an
  // ephemeral per-boot secret is safe and keeps a shared constant out of source.
  return value && value.length > 0 ? value : randomBytes(32).toString('hex');
}

const HEX_64_RE = /^[0-9a-f]{64}$/i;

/**
 * Resolve CONNECTIONS_MASTER_KEY (MN-252), or refuse to boot. This key seals
 * every row in `connections` (secretbox.ts) — an OAuth token, an Apify key, a
 * Resend key — so a weak or shared key is exactly as bad as a weak
 * BETTER_AUTH_SECRET, just for credentials instead of sessions.
 *
 * In production it must be an explicit 64-char hex string (32 bytes for
 * AES-256), the same shape `openssl rand -hex 32` produces. Outside
 * production, an unset key is derived deterministically via HKDF from
 * BETTER_AUTH_SECRET, so a local setup needs no new env var — but note this
 * means a dev/test key changes whenever BETTER_AUTH_SECRET does (including
 * BETTER_AUTH_SECRET's own per-boot randomness when it is unset), so rows
 * sealed in one boot won't decrypt after a restart unless BETTER_AUTH_SECRET
 * is itself pinned in `.env`. That mirrors the existing session-secret
 * trade-off exactly, and self-host operators already set BETTER_AUTH_SECRET.
 */
export function resolveConnectionsMasterKey(
  nodeEnv: 'development' | 'test' | 'production',
  provided: string | undefined,
  authSecret: string,
): string {
  const value = provided?.trim();
  if (nodeEnv === 'production') {
    const weak = !value || !HEX_64_RE.test(value);
    if (weak) {
      throw new Error(
        [
          'FATAL: refusing to boot in production with an unsafe CONNECTIONS_MASTER_KEY.',
          value
            ? 'The value is not a 64-character hex string (32 bytes).'
            : 'CONNECTIONS_MASTER_KEY is not set.',
          'This key encrypts every connected provider credential at rest — a weak or',
          'guessable value defeats that entirely. Set a strong, unique key before starting:',
          '',
          '    CONNECTIONS_MASTER_KEY=$(openssl rand -hex 32)',
          '',
        ].join('\n'),
      );
    }
    return value.toLowerCase();
  }
  if (value && HEX_64_RE.test(value)) return value.toLowerCase();
  // development / test: derive from BETTER_AUTH_SECRET via HKDF-SHA256 so a
  // fresh checkout encrypts/decrypts connections with zero extra setup.
  const derived = hkdfSync(
    'sha256',
    Buffer.from(authSecret, 'utf8'),
    Buffer.alloc(0),
    Buffer.from('storyos.connections.master-key.v1'),
    32,
  );
  return Buffer.from(derived).toString('hex');
}

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z
    .string()
    .default('postgres://storyos:storyos@localhost:5432/storyos'),
  /** Public URL of the API (better-auth base). */
  API_URL: z.string().default('http://localhost:3001'),
  /** Web app origin, for auth redirects/trusted origins. */
  WEB_URL: z.string().default('http://localhost:3000'),
  /** Resolved via resolveAuthSecret() in env(); never defaulted to a constant. */
  BETTER_AUTH_SECRET: z.string().optional(),
  /**
   * Resolved via resolveConnectionsMasterKey() in env() (MN-252); never
   * defaulted to a constant. Encrypts the `connections` registry at rest.
   */
  CONNECTIONS_MASTER_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('StoryOS <noreply@storyos.local>'),
  /**
   * Transactional email via Resend's HTTP API (MN-103) — invitations, mention
   * notifications, and better-auth's verification/reset mail. Preferred over
   * SMTP_HOST when both are set. Unset (every self-host, and any dev box that
   * hasn't wired Resend) falls back to SMTP_HOST if that's configured, else
   * emails are logged instead of sent — same "never crash" degrade the mailer
   * has always had.
   */
  RESEND_API_KEY: z.string().optional(),
  /**
   * MN-256 — send_email automation action daily send cap, per plan. Plain
   * env-tunable numbers (not a PlanDef field in billing/plans.ts) until the
   * entitlements model grows a per-capability metering key for it — see
   * billing epic MN-168's follow-up. `entitlements.service.ts`'s
   * `emailDailyCap()` is the one place these are read; self-host (Stripe
   * disabled) ignores them entirely (unlimited, same as every other
   * entitlement there).
   */
  EMAIL_DAILY_CAP_FREE: z.coerce.number().int().positive().default(20),
  EMAIL_DAILY_CAP_PRO: z.coerce.number().int().positive().default(200),
  EMAIL_DAILY_CAP_BUSINESS: z.coerce.number().int().positive().default(1_000),
  EMAIL_DAILY_CAP_ENTERPRISE: z.coerce.number().int().positive().default(10_000),
  /** OAuth for the hosted MCP (MN-154). Off by default; requires the oidc tables migrated.
   * When on, better-auth acts as the OAuth authorization server for MCP connectors. PATs
   * keep working either way. */
  MCP_OAUTH: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /** Per token/session. Test default is effectively unlimited. */
  RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .default(process.env.NODE_ENV === 'test' ? 1_000_000 : 300),
  /**
   * MN-257 — better-auth's sign-in routes are mounted directly on the raw
   * Fastify instance (see mountAuthHandler in app.setup.ts), bypassing Nest's
   * guard chain entirely, including ApiThrottlerGuard. These two env vars
   * bound the app-level backstop applied in src/auth/auth-rate-limit.ts.
   * Test default is effectively unlimited, same convention as
   * RATE_LIMIT_PER_MINUTE above — individual test files that need to actually
   * reach the limit override it via process.env before the app module import
   * (see test/helpers/auth-rate-limit.ts).
   */
  AUTH_SIGNIN_RATE_LIMIT_MAX: z.coerce
    .number()
    .int()
    .positive()
    .default(process.env.NODE_ENV === 'test' ? 1_000_000 : 10),
  AUTH_SIGNIN_RATE_LIMIT_WINDOW_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(60_000),
  /**
   * Containers run migrations on boot (MN-031); dev uses pnpm db:migrate.
   *
   * NOT z.coerce.boolean(): that wraps JS's Boolean(), and Boolean("false") is
   * true — any non-empty string coerces to true, silently inverting an explicit
   * "false" in .env/compose. Same trap MCP_OAUTH and STRIPE_TAX_ENABLED above
   * already work around.
   */
  RUN_MIGRATIONS: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /** Attachment storage (MN-029): local disk by default, s3 for MinIO/S3. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  ATTACHMENTS_DIR: z.string().default('./data/attachments'),
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('storyos-attachments'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  /**
   * Path-style S3 addressing, needed for MinIO/most S3-compatible endpoints.
   * Defaults to true (the common case for self-hosted S3). NOT z.coerce.boolean()
   * — same silent-inversion trap as RUN_MIGRATIONS above; an explicit
   * S3_FORCE_PATH_STYLE=false must actually disable it.
   */
  S3_FORCE_PATH_STYLE: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? true : v === 'true' || v === '1')),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /**
   * MN-263 — extra comma-separated CIDRs (v4 or v6) net-guard.ts always
   * refuses, on top of its built-in private/reserved/metadata blocklist.
   * For hosted-infra ranges specific to a deployment (e.g. a VPC CIDR the
   * API itself lives in) that aren't covered by the generic private-address
   * check. Empty by default.
   */
  BLOCKED_CIDRS: z.string().optional().default(''),
  /**
   * MN-263 — self-host escape hatch: comma-separated CIDRs allowed to bypass
   * net-guard's private-address refusal, but ONLY on the http_request
   * automation action's send path (net-guard.ts's assertPublicHost takes this
   * as an explicit opt-in list, never a global toggle). Lets a self-hosted
   * StoryOS call an intranet API (e.g. 10.0.5.20) from a rule. Never bypasses
   * BLOCKED_CIDRS or the metadata-address blocklist — those stay refused even
   * when a CIDR here would otherwise cover them. Empty by default (nothing is
   * private-allowed until an operator opts in).
   */
  HTTP_ACTION_ALLOW_PRIVATE_CIDRS: z.string().optional().default(''),
  /**
   * #239 — daily YouTube Data API v3 quota (default 10,000 units, the stock
   * per-project allocation; reads cost 1 unit/call). SourcesService checks
   * this before each sync cycle and marks the run 'skipped_quota' instead of
   * calling the API once a connection's same-day usage would exceed it.
   */
  YOUTUBE_DAILY_QUOTA_UNITS: z.coerce.number().int().positive().default(10_000),
  /**
   * Billing (MN-165). All optional: with STRIPE_SECRET_KEY unset the billing
   * module runs in "disabled" mode — every workspace is Free, checkout/portal
   * endpoints 503, and the webhook no-ops. Self-hosters never touch Stripe.
   * Price ids come from `pnpm --filter @storyos/api billing:seed` (test mode).
   */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),
  /** The $12/member/mo licensed seat-overage price, shared by Pro and Business. */
  STRIPE_PRICE_SEAT: z.string().optional(),
  /**
   * Stripe Tax is OFF by default (MN-165). It's a paid add-on that needs the Tax
   * settings activated; enable only when you're ready to calculate/collect VAT or
   * sales tax. With it off, Checkout neither computes nor collects tax.
   *
   * NOT z.coerce.boolean(): that wraps JS's Boolean(), and Boolean("false") is
   * true — any non-empty string coerces to true, silently inverting an explicit
   * "false" in .env/compose. Same trap MCP_OAUTH above already works around.
   */
  STRIPE_TAX_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  /** 30 days per MN-107; overridable only to shorten dev cycles. */
  BILLING_TRIAL_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * MN-189 follow-up (#265) — how many consecutive off-session auto-reload
   * charge failures a workspace tolerates before auto-reload is disabled and
   * the workspace notified. See AI_CREDIT_AUTO_RELOAD_BACKOFF_MINUTES
   * (plans.ts) for the backoff between attempts; if this is set higher than
   * that array's length, the last (longest) backoff is reused for the extra
   * attempts.
   */
  AI_CREDIT_AUTO_RELOAD_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  /**
   * MN-104 — the instance operator. On boot, if a user with this email
   * exists, they're granted platform_admin (idempotent). Unset = nobody is a
   * platform admin and /admin is unreachable by anyone. Re-checked every
   * boot, so setting this before the operator has signed up is safe — it
   * just no-ops until they do, then takes effect on the next restart.
   */
  PLATFORM_ADMIN_EMAIL: z.string().optional(),
  /**
   * MN-217c (#246) — the Architect's managed proposer (`ManagedAiProposer`,
   * managed-ai-client.ts) calls OpenAI's Chat Completions API directly over
   * `fetch` (no SDK). Unset means the proposer throws a clear "not
   * configured" 422 rather than silently degrading to template matching —
   * same honesty as RESEND_API_KEY/STRIPE_SECRET_KEY above, and the same
   * reasoning `ManagedAiRuntime`'s stub documents for the sibling runtime seam.
   */
  OPENAI_API_KEY: z.string().optional(),
  /** Model id for the managed proposer's completion call. */
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
});

export type Env = Omit<
  z.infer<typeof envSchema>,
  'BETTER_AUTH_SECRET' | 'CONNECTIONS_MASTER_KEY'
> & {
  /** Always resolved to a concrete secret (or boot is refused). */
  BETTER_AUTH_SECRET: string;
  /** Always resolved to a 64-char hex key (or boot is refused). */
  CONNECTIONS_MASTER_KEY: string;
};

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = envSchema.parse(process.env);
    const authSecret = resolveAuthSecret(parsed.NODE_ENV, parsed.BETTER_AUTH_SECRET);
    cached = {
      ...parsed,
      BETTER_AUTH_SECRET: authSecret,
      CONNECTIONS_MASTER_KEY: resolveConnectionsMasterKey(
        parsed.NODE_ENV,
        parsed.CONNECTIONS_MASTER_KEY,
        authSecret,
      ),
    };
  }
  return cached;
}
