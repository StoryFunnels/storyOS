/**
 * #451 — seed a persistent agent UAT environment.
 *
 *     pnpm seed:agent-uat --persona nadia
 *     pnpm seed:agent-uat --persona kai --seed 2
 *
 * Nadia's environment is eleven uneven client workspaces, ~18 databases and
 * ~2,400 records spread over six months. Kai's is one document-heavy solo
 * workspace of ~900 deliberately half-finished records. Both exist because an
 * operator on an empty database reports bugs that are artefacts of having no
 * data — #404 passed every test on a three-record workspace and then broke on
 * the founder's real 148-row one.
 *
 * There is NO reset flag, deliberately. These environments are persistent and
 * the accumulated data is the instrument: re-running tops up what is missing
 * and touches nothing else. To start over, drop the database yourself — that
 * should be a decision, not a flag someone reaches for by habit.
 */
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createHash } from 'node:crypto';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { applyPlan } from './apply';
import { buildPlan, type Persona } from './plan';

interface Args {
  persona: Persona;
  seed: string;
  scale: number;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const persona = get('persona');
  if (persona !== 'nadia' && persona !== 'kai') {
    throw new Error('--persona must be "nadia" or "kai"');
  }
  const scaleRaw = get('scale');
  const scale = scaleRaw ? Number(scaleRaw) : 1;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error('--scale must be a positive number');
  return { persona, seed: get('seed') ?? '1', scale, dryRun: argv.includes('--dry-run') };
}

/** The plan's fingerprint. Two environments that print the same hash hold the same intended data. */
export function planHash(plan: unknown): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex').slice(0, 16);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const plan = buildPlan(args.persona, args.seed, { scale: args.scale });

  console.log(`seed:agent-uat — persona ${args.persona}, seed ${args.seed}, scale ${args.scale}`);
  console.log(`plan ${planHash(plan)}: ${plan.totals.workspaces} workspaces, ${plan.totals.databases} databases, ${plan.totals.records} records`);
  if (args.dryRun) {
    console.log('--dry-run: nothing written.');
    return;
  }

  const started = Date.now();
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ bodyLimit: 3 * 1024 * 1024 }), {
    logger: ['error', 'warn'],
  });
  configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  try {
    const result = await applyPlan(app, plan, (msg) => console.log(msg));
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(
      `done in ${seconds}s — ${result.workspaces_created} workspaces created, ${result.workspaces_topped_up} topped up, ` +
        `${result.databases_created} databases, ${result.records_created} records, ${result.records_edited} edits, ` +
        `${result.links_created} links, guest ${result.guest_granted ? 'granted' : 'not granted'}`,
    );
    if (seconds > 300) {
      console.warn('WARNING: this run took longer than the five minutes #451 budgets for a setup step.');
    }
  } finally {
    await app.close();
  }
}

// Only when run as a script — importing this module (the tests do) must not seed.
if (process.argv[1] && process.argv[1].includes('agent-uat')) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
