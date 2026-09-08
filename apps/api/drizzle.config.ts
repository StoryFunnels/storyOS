import { defineConfig } from 'drizzle-kit';

/**
 * #629 — no silent fallback to the shared dev database.
 *
 * drizzle-kit auto-loads apps/api/.env from its own working directory (verified
 * directly: with that file absent AND DATABASE_URL unset in the shell, this used
 * to default straight to postgres://storyos:storyos@localhost:5432/storyos — the
 * one database every worktree and every parallel agent session can reach). A
 * fresh worktree has no apps/api/.env by construction (gitignored), so this was
 * the exact, silent, first-run state a `git worktree add` always starts in.
 *
 * Failing fast here is deliberately the whole fix — no per-worktree default, no
 * migration-count heuristic. Those either invent a database nobody asked for or
 * add a second source of truth about which database is "right". An operator who
 * has not said which database they mean should be told that, not guessed for.
 */
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Refusing to fall back to the shared dev database ' +
      '(#629) — create apps/api/.env from apps/api/.env.example, or export ' +
      'DATABASE_URL, before running db:generate/db:migrate/db:studio.',
  );
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url },
});
