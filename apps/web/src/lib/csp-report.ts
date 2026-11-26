// Ticket #1238: turns a browser's CSP violation report into ONE safe log line. The report endpoint is unauthenticated (browsers
// send reports without credentials), so everything it receives is hostile input: it is size-capped, parsed defensively, reduced to
// a fixed set of fields, and every URL is cut down to its origin. A document URL can carry a share-link token or an invite
// token, so no path or query ever reaches the log.

/** Reports larger than this are dropped unread. A real report is under 2 KB. */
export const MAX_REPORT_BYTES = 16 * 1024;

export type CspViolation = {
  directive: string;
  blocked: string;
  page: string;
  source: string | null;
  line: number | null;
  disposition: string | null;
};

const PSEUDO = ['inline', 'eval', 'data', 'blob', 'self', 'wasm-eval', 'trusted-types-policy', 'trusted-types-sink'];

/** `scheme://host[:port]` of a URL; the keyword for the pseudo-values browsers use (`inline`, `eval`, `data`); else `invalid`. */
export function originOnly(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'none';
  if (PSEUDO.includes(value)) return value;
  try {
    const u = new URL(value);
    if (u.protocol === 'data:' || u.protocol === 'blob:') return u.protocol.slice(0, -1);
    return u.origin === 'null' ? u.protocol : u.origin;
  } catch {
    return 'invalid';
  }
}

const short = (v: unknown, max = 80): string => (typeof v === 'string' ? v.replace(/[^\w '*:.-]/g, '').slice(0, max) : 'none');
const asRecord = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/**
 * Accepts both report formats: the legacy `report-uri` body (`{"csp-report": {...}}`, kebab-case keys) and the Reporting API
 * body (an array of `{type: "csp-violation", body: {...}}`, camelCase keys). Returns the violations it understood (at most 10);
 * anything else yields `[]`.
 */
export function parseCspReport(raw: string): CspViolation[] {
  if (raw.length > MAX_REPORT_BYTES) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return [];
  }
  const bodies: Record<string, unknown>[] = [];
  const legacy = asRecord(asRecord(json)?.['csp-report']);
  if (legacy) bodies.push(legacy);
  if (Array.isArray(json)) {
    for (const item of json.slice(0, 10)) {
      const entry = asRecord(item);
      const body = asRecord(entry?.body);
      if (entry?.type === 'csp-violation' && body) bodies.push(body);
    }
  }
  return bodies.slice(0, 10).map((b) => {
    const pick = (...keys: string[]) => keys.map((k) => b[k]).find((v) => v !== undefined);
    const line = pick('line-number', 'lineNumber');
    const source = pick('source-file', 'sourceFile');
    const disposition = pick('disposition');
    return {
      directive: short(pick('effective-directive', 'effectiveDirective', 'violated-directive', 'violatedDirective')),
      blocked: originOnly(pick('blocked-uri', 'blockedURL', 'blockedURI')),
      page: originOnly(pick('document-uri', 'documentURL', 'documentURI')),
      source: source === undefined ? null : originOnly(source),
      line: typeof line === 'number' && Number.isFinite(line) ? Math.trunc(line) : null,
      disposition: typeof disposition === 'string' ? short(disposition, 16) : null,
    };
  });
}

/** A fixed budget of log lines per window, so an anonymous caller cannot flood the container's log. */
export function createLogBudget(limit: number, windowMs: number, now: () => number = Date.now) {
  let windowStart = now();
  let used = 0;
  return () => {
    const t = now();
    if (t - windowStart >= windowMs) {
      windowStart = t;
      used = 0;
    }
    if (used >= limit) return false;
    used += 1;
    return true;
  };
}
