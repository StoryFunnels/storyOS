/**
 * Ticket #1321 — the figure beside "Runners" in the Settings menu. The API (ticket #1320, `runner-counts.ts`) decides what
 * "connected" is and when something needs attention; this only reads those three fields and words them. It never counts the rows it
 * was given and never derives `needs_attention`: a second definition is how two screens come to disagree.
 *
 * "Never guess numbers": a body that does not carry all three fields as the right kind of value (an API that predates them, a
 * fixture, an array) is `undefined`, which draws nothing. It is never read as a zero.
 */
export interface RunnerCounts {
  connected: number;
  total: number;
  needsAttention: boolean;
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** The counts out of the `GET /workspaces/{ws}/runners` body, or `undefined` when it does not carry them. */
export function readRunnerCounts(body: unknown): RunnerCounts | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  if (!isCount(b.connected_count) || !isCount(b.total_count) || typeof b.needs_attention !== 'boolean') return undefined;
  return { connected: b.connected_count, total: b.total_count, needsAttention: b.needs_attention };
}

/**
 * The count drawn on the Runners row: "N connected", in the warning colour exactly when the server says something needs attention.
 * Nothing when the figure is unknown (not asked, refused, failed) and nothing when the person has no Runner at all: "0 connected"
 * would be true and would read as a fault on a workspace that never set one up.
 */
export function runnerNavCount(counts: RunnerCounts | undefined): { text: string; warn?: boolean } | undefined {
  if (!counts || counts.total === 0) return undefined;
  return { text: `${counts.connected} connected`, warn: counts.needsAttention };
}
