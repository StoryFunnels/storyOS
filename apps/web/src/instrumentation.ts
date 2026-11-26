import { cspModeProblem } from '@/lib/security-headers.mjs';

/**
 * Ticket #1343: runs once when the web server boots. The only thing it does is warn about a `CSP_MODE` that is set to something
 * other than exactly `report-only`: that value ENFORCES the policy (see `cspMode`), so an operator who typed `Report-Only` and
 * believes the policy is relaxed would otherwise get no hint until a page stays broken. Unset or empty is silent.
 */
export function register() {
  const problem = cspModeProblem(process.env.CSP_MODE);
  if (problem) console.warn(`[csp] ${problem}`);
}
