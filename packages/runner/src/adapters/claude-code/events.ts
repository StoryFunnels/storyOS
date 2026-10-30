// SPDX-License-Identifier: Apache-2.0
import { redact } from '../../redact.js';
import type { AdapterResult } from '../types.js';
import type { SpawnOutcome } from './process.js';

/**
 * Reading what `claude -p --output-format stream-json --verbose` says, and turning it into the adapter's answer.
 *
 * WHAT WAS CHECKED AGAINST THE REAL CLI (2.1.104, ticket #1135 premise check) and what was not:
 *  - VERIFIED live: the `system`/`init` event, the `assistant` event with `error: "authentication_failed"`, and the `result` event's
 *    fields (`subtype`, `is_error`, `num_turns`, `result`, `session_id`, `total_cost_usd`, `usage`, `permission_denials`). A failed
 *    run says `subtype: "success"` with `is_error: true`, so `is_error` decides, never `subtype`.
 *  - READ FROM THE BINARY, NOT SEEN LIVE (UNVERIFIED): the `rate_limit_event` shape and its `resetsAt` (epoch SECONDS), the
 *    `assistant.error` value `"rate_limit"`, the text "You've hit your ...", and the denial entry in `permission_denials`. A usage
 *    limit could not be provoked: the machine's login had expired. Each place that depends on one of those says so.
 *  - Unknown events and unknown fields are ignored: the CLI is not ours and changes between versions.
 */
export interface StreamState {
  init: { sessionId?: string; model?: string; version?: string; permissionMode?: string; apiKeySource?: string; mcpServers: Array<{ name: string; status: string }> } | null;
  result: ResultEvent | null;
  /** UNVERIFIED live. Every `rate_limit_info` the CLI emitted. */
  rateLimits: RateLimitInfo[];
  /** The `error` of any assistant message: authentication_failed, rate_limit, billing_error, ... */
  assistantErrors: string[];
  lastAssistantText: string;
  /** Names of the tools the session called, for the log. Never their inputs. */
  toolCalls: string[];
  unparsedLines: number;
}

export interface ResultEvent {
  subtype?: string;
  isError: boolean;
  text: string;
  sessionId?: string;
  numTurns?: number;
  costUsd?: number;
  usage: { input: number; output: number; cacheCreate: number; cacheRead: number } | null;
  /** UNVERIFIED live: entries are objects with a `tool_name`. */
  denials: string[];
}

export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
}

export function newStreamState(): StreamState {
  return { init: null, result: null, rateLimits: [], assistantErrors: [], lastAssistantText: '', toolCalls: [], unparsedLines: 0 };
}

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function readLine(state: StreamState, line: string): void {
  let e: Record<string, unknown> | null;
  try {
    e = asObj(JSON.parse(line));
  } catch {
    state.unparsedLines += 1;
    return;
  }
  if (!e) {
    state.unparsedLines += 1;
    return;
  }
  switch (e.type) {
    case 'system': {
      if (e.subtype !== 'init') return;
      const servers = Array.isArray(e.mcp_servers) ? e.mcp_servers : [];
      state.init = {
        ...(asStr(e.session_id) ? { sessionId: asStr(e.session_id)! } : {}),
        ...(asStr(e.model) ? { model: asStr(e.model)! } : {}),
        ...(asStr(e.claude_code_version) ? { version: asStr(e.claude_code_version)! } : {}),
        ...(asStr(e.permissionMode) ? { permissionMode: asStr(e.permissionMode)! } : {}),
        ...(asStr(e.apiKeySource) ? { apiKeySource: asStr(e.apiKeySource)! } : {}),
        mcpServers: servers.flatMap((s) => {
          const o = asObj(s);
          return o && asStr(o.name) ? [{ name: asStr(o.name)!, status: asStr(o.status) ?? 'unknown' }] : [];
        }),
      };
      return;
    }
    case 'assistant': {
      const err = asStr(e.error);
      if (err) state.assistantErrors.push(err);
      const message = asObj(e.message);
      const content = Array.isArray(message?.content) ? (message!.content as unknown[]) : [];
      for (const block of content) {
        const b = asObj(block);
        if (!b) continue;
        if (b.type === 'text' && asStr(b.text)) state.lastAssistantText = asStr(b.text)!;
        if (b.type === 'tool_use' && asStr(b.name)) state.toolCalls.push(asStr(b.name)!);
      }
      return;
    }
    case 'rate_limit_event': {
      const info = asObj(e.rate_limit_info);
      if (!info) return;
      state.rateLimits.push({
        ...(asStr(info.status) ? { status: asStr(info.status)! } : {}),
        ...(asNum(info.resetsAt) !== undefined ? { resetsAt: asNum(info.resetsAt)! } : {}),
        ...(asStr(info.rateLimitType) ? { rateLimitType: asStr(info.rateLimitType)! } : {}),
        ...(asStr(info.overageStatus) ? { overageStatus: asStr(info.overageStatus)! } : {}),
      });
      return;
    }
    case 'result': {
      const u = asObj(e.usage);
      const denials = Array.isArray(e.permission_denials) ? e.permission_denials : [];
      state.result = {
        ...(asStr(e.subtype) ? { subtype: asStr(e.subtype)! } : {}),
        isError: e.is_error === true,
        text: asStr(e.result) ?? '',
        ...(asStr(e.session_id) ? { sessionId: asStr(e.session_id)! } : {}),
        ...(asNum(e.num_turns) !== undefined ? { numTurns: asNum(e.num_turns)! } : {}),
        ...(asNum(e.total_cost_usd) !== undefined ? { costUsd: asNum(e.total_cost_usd)! } : {}),
        usage: u
          ? { input: asNum(u.input_tokens) ?? 0, output: asNum(u.output_tokens) ?? 0, cacheCreate: asNum(u.cache_creation_input_tokens) ?? 0, cacheRead: asNum(u.cache_read_input_tokens) ?? 0 }
          : null,
        denials: denials.flatMap((d) => {
          const o = asObj(d);
          return o && asStr(o.tool_name) ? [asStr(o.tool_name)!] : [];
        }),
      };
      return;
    }
    default:
      return;
  }
}

export const SUMMARY_CAP = 6_000;
const ERROR_CAP = 1_500;

function cap(text: string, max: number): string {
  const t = redact(text.trim());
  return t.length <= max ? t : `${t.slice(0, max)}\n[cut: ${t.length - max} more characters]`;
}

/** The text the CLI prints when a subscription limit stops it. UNVERIFIED live: read from the 2.1.104 binary. */
const LIMIT_TEXT = /^You(?:'|’)ve hit your\b/i;

export interface LimitReading {
  hit: boolean;
  /** ISO time, only when the CLI gave an epoch we can trust. */
  until?: string;
  why: string;
}

/** Is this stop a subscription limit, and if so when does it lift? Called only for a run that did not succeed. */
export function readLimit(state: StreamState, now: number): LimitReading {
  const rejected = state.rateLimits.filter((r) => r.status === 'rejected');
  const textHit = LIMIT_TEXT.test(state.result?.text ?? '') || LIMIT_TEXT.test(state.lastAssistantText);
  const errorHit = state.assistantErrors.includes('rate_limit');
  if (!rejected.length && !errorHit && !textHit) return { hit: false, why: '' };
  // Several windows may be reported (five hour, weekly). The run is blocked until the LATEST rejected one lifts, and an overage
  // window that is still allowed does not count as a block.
  const times = rejected.flatMap((r) => (typeof r.resetsAt === 'number' ? [normaliseEpoch(r.resetsAt)] : []));
  const latest = times.length ? Math.max(...times) : undefined;
  const why = rejected.length ? `rate_limit_event rejected (${rejected.map((r) => r.rateLimitType ?? 'unknown window').join(', ')})` : errorHit ? 'assistant error rate_limit' : 'the CLI said it hit a limit';
  return latest !== undefined && latest > now ? { hit: true, until: new Date(latest).toISOString(), why } : { hit: true, why };
}

/** The CLI sends epoch SECONDS. A value that is already milliseconds (past 1e11) is taken as it is, rather than read as the year 50000. */
function normaliseEpoch(n: number): number {
  return n > 1e11 ? n : n * 1000;
}

export const LOGIN_HELP =
  'Claude Code on this computer is not signed in, or its sign-in has expired. Open a terminal on this computer, run `claude`, sign in, then let the Runner try again.';

export interface InterpretInput {
  state: StreamState;
  outcome: SpawnOutcome;
  toolVersion: string;
  now: number;
}

export function interpret({ state, outcome, toolVersion, now }: InterpretInput): AdapterResult {
  const sessionId = state.result?.sessionId ?? state.init?.sessionId;
  const base = { toolVersion, ...(sessionId ? { sessionId } : {}) };
  const usage = usageOf(state);

  if (outcome.spawnError) {
    return { exit: 'error', usage: null, summary: '', error: cap(`Claude Code could not be started: ${outcome.spawnError}`, ERROR_CAP), toolVersion };
  }
  if (outcome.aborted) return { ...base, exit: 'aborted', usage, summary: 'The Claude Code session was stopped.' };
  if (outcome.timedOut) {
    return { ...base, exit: 'timeout', usage, summary: cap(state.lastAssistantText, SUMMARY_CAP), error: 'The session was stopped because it ran longer than this Runner allows.' };
  }

  const r = state.result;
  const failed = !r || r.isError || (r.subtype !== undefined && r.subtype !== 'success') || (outcome.code !== 0 && outcome.code !== null);
  if (!failed && r) {
    const refused = [...new Set(r.denials)];
    const note = refused.length ? `\n\n[Refused by this agent's tool allowlist: ${refused.join(', ')}.]` : '';
    return { ...base, exit: 'ok', usage, summary: cap(r.text || state.lastAssistantText, SUMMARY_CAP) + note };
  }

  const limit = readLimit(state, now);
  if (limit.hit) {
    return {
      ...base,
      exit: 'limit_reached',
      usage,
      summary: cap(r?.text || state.lastAssistantText, SUMMARY_CAP),
      ...(limit.until ? { limitReachedUntil: limit.until } : {}),
      error: `Claude Code stopped at a subscription usage limit (${limit.why})${limit.until ? `; it lifts at ${limit.until}` : '; the CLI gave no reset time'}.`,
    };
  }
  if (state.assistantErrors.includes('authentication_failed') || /Failed to authenticate|authentication_error|Invalid API key|not logged in/i.test(r?.text ?? '')) {
    return { ...base, exit: 'error', usage, summary: '', error: LOGIN_HELP };
  }
  const detail = r?.text || state.lastAssistantText || outcome.stderr || (r?.subtype ? `result ${r.subtype}` : `exit ${outcome.code ?? outcome.killedBy ?? 'unknown'}`);
  const why = r ? `Claude Code reported an error${r.subtype && r.subtype !== 'success' ? ` (${r.subtype})` : ''}` : `Claude Code ended with exit ${outcome.code ?? outcome.killedBy ?? 'unknown'} and no result`;
  return { ...base, exit: 'error', usage, summary: '', error: cap(`${why}: ${detail}`, ERROR_CAP) };
}

/**
 * Tokens as the CLI reported them, or `null` when it reported none. Input counts the cached parts too, because they are input the
 * model read and the subscription metered. A result with all-zero usage on a failed call is real zero, but "no result at all" is
 * unknown, and unknown is never zero-filled.
 */
export function usageOf(state: StreamState): { tokensIn: number; tokensOut: number } | null {
  const u = state.result?.usage;
  if (!u) return null;
  return { tokensIn: u.input + u.cacheCreate + u.cacheRead, tokensOut: u.output };
}
