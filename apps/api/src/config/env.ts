import { z } from 'zod';

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
  BETTER_AUTH_SECRET: z.string().default('storyos-dev-secret-change-in-production'),
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

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
