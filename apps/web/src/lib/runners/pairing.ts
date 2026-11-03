import type { PairingCodeIssued, PairingPoll, RunnerTool } from './types';

/**
 * Ticket #1139 AC2 — "Add a Runner" as a state machine, so the three steps and every way out of them are testable without a
 * browser. The SERVER owns the truth (a code is single use and lives ten minutes, ADR-0021 §3; `GET .../pairing-codes/{id}`
 * answers waiting / connected / expired / cancelled); this reducer only follows what it says and never decides that a code worked.
 *
 *   issuing -> waiting -> connected -> activating -> done
 *                 \            \            \-> connected (activation failed: say why, stay put)
 *                  \------------\-> expired | cancelled | failed
 *
 * `done` is the ONLY state in which a Runner has been turned on, and only the server's answer to Done gets there: "Connected"
 * is not "on" (ADR-0021 Q4, the token stays pending until Done), which is why the sentence beside the button says so.
 */
export type PairingState =
  | { phase: 'issuing' }
  | { phase: 'waiting'; codeId: string; code: string; expiresAt: string }
  | { phase: 'connected'; codeId: string; code: string; expiresAt: string; runner: { id: string; name: string; tools: RunnerTool[] }; tool: string | null; error: string | null }
  | { phase: 'activating'; codeId: string; code: string; expiresAt: string; runner: { id: string; name: string; tools: RunnerTool[] }; tool: string }
  | { phase: 'done'; runnerId: string; runnerName: string; tool: string }
  | { phase: 'expired' }
  | { phase: 'cancelled' }
  | { phase: 'failed'; message: string };

export type PairingEvent =
  | { type: 'issued'; code: PairingCodeIssued }
  | { type: 'issue_failed'; message: string }
  | { type: 'polled'; poll: PairingPoll }
  | { type: 'choose_tool'; tool: string }
  | { type: 'activate' }
  | { type: 'activated'; runnerId: string; runnerName: string; tool: string }
  | { type: 'activate_failed'; message: string; expired?: boolean }
  | { type: 'cancel' };

export const pairingStart: PairingState = { phase: 'issuing' };

/** The tools a person can pick between: only what the Runner found installed on that computer. */
export function pickableTools(tools: readonly RunnerTool[]): RunnerTool[] {
  return tools.filter((t) => t.installed);
}

/** Which tool is selected when the choice first appears: the only one, or the first the Runner listed. Never one that is not installed. */
export function defaultTool(tools: readonly RunnerTool[]): string | null {
  return pickableTools(tools)[0]?.id ?? null;
}

export function pairingReducer(state: PairingState, e: PairingEvent): PairingState {
  switch (e.type) {
    case 'issued':
      return { phase: 'waiting', codeId: e.code.id, code: e.code.code, expiresAt: e.code.expires_at };
    case 'issue_failed':
      return { phase: 'failed', message: e.message };
    case 'cancel':
      // Cancel from anywhere before Done. After done there is nothing to cancel (the Runner is on): a stale click changes nothing.
      return state.phase === 'done' ? state : { phase: 'cancelled' };
    case 'polled': {
      if (state.phase !== 'waiting' && state.phase !== 'connected') return state;
      const { poll } = e;
      if (poll.status === 'expired') return { phase: 'expired' };
      if (poll.status === 'cancelled') return { phase: 'cancelled' };
      if (poll.status === 'waiting') return state;
      if (!poll.runner) return state; // "connected" with no Runner would be a server bug; keep waiting rather than invent a machine
      if (state.phase === 'connected') {
        // Already connected: keep the person's tool choice, refresh what the Runner reports.
        const stillThere = state.tool && pickableTools(poll.runner.tools).some((t) => t.id === state.tool);
        return { ...state, runner: poll.runner, tool: stillThere ? state.tool : defaultTool(poll.runner.tools) };
      }
      return {
        phase: 'connected',
        codeId: state.codeId,
        code: state.code,
        expiresAt: state.expiresAt,
        runner: poll.runner,
        tool: defaultTool(poll.runner.tools),
        error: null,
      };
    }
    case 'choose_tool':
      return state.phase === 'connected' && pickableTools(state.runner.tools).some((t) => t.id === e.tool) ? { ...state, tool: e.tool, error: null } : state;
    case 'activate':
      return state.phase === 'connected' && state.tool ? { phase: 'activating', codeId: state.codeId, code: state.code, expiresAt: state.expiresAt, runner: state.runner, tool: state.tool } : state;
    case 'activated':
      return state.phase === 'activating' ? { phase: 'done', runnerId: e.runnerId, runnerName: e.runnerName, tool: e.tool } : state;
    case 'activate_failed':
      if (state.phase !== 'activating') return state;
      if (e.expired) return { phase: 'expired' };
      return { phase: 'connected', codeId: state.codeId, code: state.code, expiresAt: state.expiresAt, runner: state.runner, tool: state.tool, error: e.message };
  }
}

/** Whether the Done button can be pressed: a tool is chosen and nothing is in flight. */
export function canPressDone(state: PairingState): boolean {
  return state.phase === 'connected' && state.tool !== null;
}

/** Whether the poll should keep running: only while the answer can still change. */
export function shouldPoll(state: PairingState): boolean {
  return state.phase === 'waiting' || state.phase === 'connected';
}

/** The server's code is 6 characters from an unambiguous alphabet. It is shown as two groups of three, like the design's "K7P 4QX". */
export function displayCode(code: string): string {
  const c = code.replace(/[\s-]/g, '').toUpperCase();
  return c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

/** The accessible name: each character read on its own, since "K7P" read as a word is useless to someone typing it. */
export function codeAriaLabel(code: string): string {
  return `Pairing code ${code.replace(/[\s-]/g, '').toUpperCase().split('').join(' ')}`;
}

export function expiredCopy(): string {
  return 'That code ran out. Codes work once, for ten minutes.';
}
