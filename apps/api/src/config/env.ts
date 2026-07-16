import { randomBytes } from 'node:crypto';
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

const envSchema = z.object({
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
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('StoryOS <noreply@storyos.local>'),
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
  /** Containers run migrations on boot (MN-031); dev uses pnpm db:migrate. */
  RUN_MIGRATIONS: z.coerce.boolean().default(false),
  /** Attachment storage (MN-029): local disk by default, s3 for MinIO/S3. */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  ATTACHMENTS_DIR: z.string().default('./data/attachments'),
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(20 * 1024 * 1024),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('storyos-attachments'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(true),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

export type Env = Omit<z.infer<typeof envSchema>, 'BETTER_AUTH_SECRET'> & {
  /** Always resolved to a concrete secret (or boot is refused). */
  BETTER_AUTH_SECRET: string;
};

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = envSchema.parse(process.env);
    cached = {
      ...parsed,
      BETTER_AUTH_SECRET: resolveAuthSecret(
        parsed.NODE_ENV,
        parsed.BETTER_AUTH_SECRET,
      ),
    };
  }
  return cached;
}
