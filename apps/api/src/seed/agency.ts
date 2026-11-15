/**
 * #1297 — `pnpm --filter @storyos/api seed:agency`: load the fake Pinewood Studio agency.
 *
 * Called by scripts/pinewood/pinewood-up.sh (refresh) and pinewood-template.sh (template build),
 * both of which run it under `env -i` with only DATABASE_URL, so the password comes from
 * PINEWOOD_SEED_PASSWORD or the stack's throwaway env file (see agency-guard.ts), never from the repo.
 *
 * It refuses, before the app boots, any database that is not storyos_pinewood* (or the
 * storyos_agency_tpl* template), any non-local host, and production. Idempotent: a second run
 * adds nothing and touches nothing. `--dry-run` prints what it would load and writes nothing.
 */
// MUST be first: it is what lets DATABASE_URL in apps/api/.env be seen (and be refused) here.
import '../config/load-env';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { AgencySeedRefused, guardAgencyTarget, resolveSeedPassword } from './agency-guard';
import { applyAgency } from './agency-apply';
import { buildAgencyData, countAgencyRecords } from './agency-data';

async function main() {
  const target = guardAgencyTarget(process.env);
  const data = buildAgencyData(new Date());
  console.log(`seed:agency: Pinewood Studio -> ${target.database} (${countAgencyRecords(data)} records planned)`);
  if (process.argv.includes('--dry-run')) {
    console.log('--dry-run: nothing written.');
    return;
  }
  const { password, source, file } = resolveSeedPassword(process.env);
  if (source === 'generated') console.log(`seed:agency: generated a throwaway login password and stored it in ${file} (mode 600)`);

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: 3 * 1024 * 1024 }), {
    // Errors only: with no mail configured the mail service WARNS with every verify and invite link in full. Throwaway links, but they do not belong in a log.
    logger: ['error'],
  });
  configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  try {
    const result = await applyAgency(app, { password, log: (m) => console.log(m) });
    console.log(
      `seed:agency: done. ${result.records_created} records created, ${result.links_created} links, ${result.members_invited} members invited, ` +
        `${result.agent_comments_created} agent comments, approval ${result.approval_pending ? 'pending' : 'NOT pending'}`,
    );
  } finally {
    await app.close();
  }
}

if (process.argv[1] && /seed[\\/]agency\.js$/.test(process.argv[1])) {
  main().catch((err) => {
    if (err instanceof AgencySeedRefused) {
      console.error(err.message);
      process.exit(2);
    }
    console.error(err);
    process.exit(1);
  });
}
