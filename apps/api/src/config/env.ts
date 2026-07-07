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
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  cached ??= envSchema.parse(process.env);
  return cached;
}
