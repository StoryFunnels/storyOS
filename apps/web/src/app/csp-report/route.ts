import { createLogBudget, MAX_REPORT_BYTES, parseCspReport } from '@/lib/csp-report';

/**
 * Ticket #1238: where browsers send Content-Security-Policy violation reports (`report-uri /csp-report`). It stores nothing: each
 * violation becomes one JSON line on the container's stdout (origins only, see lib/csp-report.ts), which is how an operator
 * sees what the enforced policy blocks. Always answers 204 and never says what it understood, so it is no oracle.
 *
 * Lives outside `/api/*` on purpose: the compose Caddyfile sends every `/api/*` path to the api container.
 */
export const dynamic = 'force-dynamic';

const mayLog = createLogBudget(30, 60_000);

export async function POST(request: Request) {
  // A declared size over the cap is never read; an undeclared one is read and dropped by parseCspReport if it is too big.
  if (Number(request.headers.get('content-length') ?? 0) <= MAX_REPORT_BYTES) {
    for (const violation of parseCspReport(await request.text())) {
      if (!mayLog()) break;
      console.warn(JSON.stringify({ event: 'csp_violation', ...violation }));
    }
  }
  return new Response(null, { status: 204 });
}
