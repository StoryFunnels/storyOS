/**
 * #316 — load `apps/api/.env` in development, BEFORE anything reads config.
 *
 * The file has always existed and has always been ignored. Nothing in the API
 * loaded dotenv, so `src/config/env.ts` parsed `process.env` alone — and because
 * the zod defaults happen to match exactly what the docs tell you to put in the
 * file, everything looked fine. It only broke when a value needed to DIFFER from
 * its default: a scratch database, a real SMTP host, a non-default WEB_URL. The
 * edit then silently did nothing, which is worse than having no config file at
 * all, because you believe you have changed something you have not. (Found while
 * pointing a UAT run at an isolated database and watching the API keep writing
 * to the founder's dev data.)
 *
 * Two things make this safe:
 *
 * 1. DEVELOPMENT ONLY. In production the container gets real environment
 *    variables and no file is read or required — deployment behaviour is
 *    unchanged, and a stray `.env` inside an image can never override it.
 * 2. EXISTING VARS WIN. `process.loadEnvFile` does not overwrite a variable that
 *    is already set, so `DATABASE_URL=… pnpm dev` still beats the file. That
 *    ordering matters: the test suite and the UAT launch config both pass
 *    DATABASE_URL inline and must keep winning.
 *
 * Uses Node's built-in loader rather than adding a `dotenv` dependency — the
 * repo already requires Node >= 22.
 *
 * IMPORT THIS FIRST. `env()` is called during Nest module initialisation, and
 * imports are evaluated before the importing module's body runs, so this has to
 * be the first import in `main.ts` to be in time.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadDevEnvFile(): string | null {
  if (process.env.NODE_ENV === 'production') return null;

  // `__dirname` is dist/config at runtime and src/config under ts-node, so the
  // package root is two levels up either way.
  const envPath = join(__dirname, '..', '..', '.env');
  if (!existsSync(envPath)) return null;

  try {
    process.loadEnvFile(envPath);
    return envPath;
  } catch {
    // A malformed .env must not stop the API booting — the zod parse in
    // `config/env.ts` is what reports genuinely missing configuration, with a
    // far better message than a parse error here would give.
    return null;
  }
}

loadDevEnvFile();
