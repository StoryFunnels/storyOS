import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * #882 — WHICH credential (an `api_tokens` row) is acting in this request, so durable provenance rows can name it without every
 * write path having to thread it through (the #541 agent triplet is positional parameters through dozens of calls; this is the
 * one-line sibling). Entered once per request by `RequestMemoInterceptor` from `request.auth.tokenId`, which the auth guard sets only
 * for a personal access token. A session, an OAuth grant, a job or a script has NO store, so the answer is `null`: absence is
 * recorded as absence, never as a person.
 *
 * Leaf module with no imports of ours, because `db/schema.ts` reads it from a column default.
 */
/**
 * #1059 — WHO is acting, beside which credential: the person, what kind of actor (a human, an agent, an MCP client, an automation) and the
 * agent behind a token. Structural audit events (a space, database or view deleted, restored, restricted) are written deep inside services
 * that never took an actor, from REST and from MCP alike; this is how they are attributed without threading three parameters through every
 * caller. Same rule as `tokenId`: outside a request there is no store, and absence is recorded as absence, never as a person.
 */
export interface RequestActor {
  userId: string | null;
  source: 'human' | 'agent' | 'automation' | 'mcp' | null;
  agentId: string | null;
  agentName: string | null;
}

/**
 * #1132 — the Runner run behind this request, when the credential is a RUN credential (ADR-0021 §4): the Run record, the Runner, the
 * Runner's name as it is now (snapshotted onto each audit row) and the wake's loop-guard depth. Absent for every other request.
 */
export interface RunStamp {
  /** Null for a wake that has no Run record. */
  runId: string | null;
  runnerId: string;
  runnerName: string | null;
  depth: number;
}

const store = new AsyncLocalStorage<{ tokenId: string | null; actor: RequestActor | null; run: RunStamp | null }>();

export function runWithCredential<T>(tokenId: string | null, fn: () => T, actor: RequestActor | null = null, run: RunStamp | null = null): T {
  return store.run({ tokenId, actor, run }, fn);
}

export function currentRunStamp(): RunStamp | null {
  return store.getStore()?.run ?? null;
}

export function currentActor(): RequestActor | null {
  return store.getStore()?.actor ?? null;
}

export function currentCredentialId(): string | null {
  return store.getStore()?.tokenId ?? null;
}

/**
 * #1174 / ADR-0021 §7 — WHO CAUSED an event: the agent and the Runner run behind a write made with a RUN credential. Carried on
 * `DomainEvent.origin` and through automation runs so a rule's OUTWARD actions can be held for a person (action-classes.ts), and
 * persisted wherever an event is handed across a queue (automation jobs, approval snapshots, bulk record jobs), because this
 * AsyncLocalStorage does not survive a database row. Absent (null) for everything that is not a run credential: a person, an
 * automation, a server-run agent (which stages through agents.service.ts already) and an ordinary MCP token.
 */
export interface EventOrigin {
  agentId: string | null;
  agentName: string | null;
  runId: string | null;
  runnerId: string;
  runnerName: string | null;
}

/** An explicit origin (a job that carries one in its payload, or an automation run executing for an event that had one). */
const originStore = new AsyncLocalStorage<{ origin: EventOrigin | null }>();

/** The origin for work that is not a request: the persisted one wins over whatever the ambient request would say. */
export function runWithEventOrigin<T>(origin: EventOrigin | null | undefined, fn: () => T): T {
  return originStore.run({ origin: origin ?? null }, fn);
}

/** The explicit override if one is set, else derived from this request's run credential, else null. */
export function currentEventOrigin(): EventOrigin | null {
  const explicit = originStore.getStore();
  if (explicit) return explicit.origin;
  const s = store.getStore();
  if (!s?.run) return null;
  return {
    agentId: s.actor?.agentId ?? null,
    agentName: s.actor?.agentName ?? null,
    runId: s.run.runId,
    runnerId: s.run.runnerId,
    runnerName: s.run.runnerName,
  };
}

/** A persisted origin read back from jsonb: trusted only if it has the shape (a stray value is "no origin", never a crash). */
export function parseEventOrigin(raw: unknown): EventOrigin | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o['runnerId'] !== 'string') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return { agentId: str(o['agentId']), agentName: str(o['agentName']), runId: str(o['runId']), runnerId: o['runnerId'], runnerName: str(o['runnerName']) };
}
