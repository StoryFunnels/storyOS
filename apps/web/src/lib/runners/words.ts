import type { RunnerTool } from './types';

/**
 * Ticket #1139 — the words for tools, times and the sentences Dara wrote. Every string a person reads on the Runner screens that
 * is not a plain label lives here, so a test can pin it and a screen cannot reword it.
 */

/** What a tool is called on screen. Unknown ids fall back to what the Runner called them. */
export function toolName(id: string | null | undefined, tools?: readonly RunnerTool[]): string {
  if (!id) return 'your AI';
  const reported = tools?.find((t) => t.id === id)?.name;
  if (reported) return reported;
  switch (id) {
    case 'claude-code':
      return 'Claude Code';
    case 'cursor':
      return 'Cursor';
    case 'codex':
      return 'Codex';
    case 'local-openai':
      return 'Your local AI';
    default:
      return id;
  }
}

/**
 * The name of the SUBSCRIPTION whose limit ran out. Dara's copy says "Waiting for your Claude limit" for Claude Code and
 * "your Cursor limit" for Cursor: the limit belongs to the account, not to the command-line tool. She fixed "Claude" showing
 * while Cursor was chosen (prototype v42), so this is keyed on the chosen tool and never defaulted.
 */
export function limitBrand(id: string | null | undefined, tools?: readonly RunnerTool[]): string {
  return id === 'claude-code' ? 'Claude' : toolName(id, tools);
}

export interface TimeOpts {
  /** Test seam: a fixed zone and locale make the strings deterministic. The app passes nothing, so it is the viewer's own. */
  timeZone?: string;
  locale?: string;
}

/** "18:40" on the viewer's clock. */
export function clockTime(iso: string | Date, o: TimeOpts = {}): string {
  return new Intl.DateTimeFormat(o.locale ?? 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: o.timeZone }).format(new Date(iso));
}

/** "29 Oct". */
export function shortDate(iso: string | Date, o: TimeOpts = {}): string {
  return new Intl.DateTimeFormat(o.locale ?? 'en-GB', { day: 'numeric', month: 'short', timeZone: o.timeZone }).format(new Date(iso));
}

/**
 * "a minute ago". Under a minute is "just now": the heartbeat is every 30 s, so a finer word would be false precision. A future
 * instant (clock skew) reads "just now" and never "in 2 minutes".
 */
export function checkedAgo(iso: string | Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m === 1) return 'a minute ago';
  if (m < 60) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h === 1) return 'an hour ago';
  if (h < 24) return `${h} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'a day ago' : `${d} days ago`;
}

/** Dara's exact strings (prototype v42 to v45, her comments on tickets #1129 and #1139). Pinned by a test. */
export const COPY = {
  command: 'npx @storyos/runner',
  firstRun:
    'It thinks with an AI you already pay for: your own Claude Code or Cursor, through a small free Runner on your computer. Setting it up takes about two minutes.',
  removeRow: 'Its agents wait until you add another Runner. Nothing is deleted.',
  hireNoRunner: 'You can hire it now. It starts work once it has a Runner.',
  doneSentence: 'Press Done to let this computer run your agents. Until then it is connected but does nothing.',
  codeNote: 'Works once, for the next 10 minutes. It only connects this computer to your account.',
  runnersLead:
    'Your hired agents think with your own Claude Code or Cursor, on your subscription. A Runner is a small free app that lets them, on your computer or an always-on server.',
} as const;

/** The Remove confirm. The agents that would wait are named; with none, the sentence stays true and names nobody. */
export function removeConfirmMessage(agentNames: readonly string[]): string {
  const who = agentNames.length === 0 ? 'Its agents wait' : agentNames.length === 1 ? `${agentNames[0]} waits` : `${agentNames.join(', ')} wait`;
  return `${who} until you add another Runner. Nothing is deleted.`;
}

/**
 * The Remove dialog's options for the shared `useConfirm()` (the shape ticket #1093's builders return). Kept beside the other
 * Runner words rather than in `settings-confirmations.ts` so the Runner wording has one home.
 */
export function confirmRemoveRunner(machine: string, agentNames: readonly string[]): { title: string; message: string; confirmLabel: string; danger: boolean } {
  return { title: `Remove ${machine}?`, message: removeConfirmMessage(agentNames), confirmLabel: 'Remove', danger: true };
}

/** "paired 29 Oct · runs Onboarding Assistant". */
export function agentsLine(agents: ReadonlyArray<{ name: string }>): string {
  if (agents.length === 0) return 'runs no agents yet';
  if (agents.length === 1) return `runs ${agents[0]!.name}`;
  if (agents.length === 2) return `runs ${agents[0]!.name} and ${agents[1]!.name}`;
  return `runs ${agents[0]!.name} and ${agents.length - 1} more`;
}

/**
 * The toast when Done succeeds (Dara, v45). It says what is TRUE: new work wakes the agent. It must not say a record that was
 * already waiting starts: wakes come from events, so a record waiting before the Runner existed wakes nothing until catch-up
 * (ticket #1152) runs, and that is not built. The agents named are the ones the Runner was actually assigned to.
 */
export function readyToast(machine: string, agentNames: readonly string[]): string {
  if (agentNames.length === 0) return `${machine} is ready.`;
  const who = agentNames.length === 1 ? agentNames[0]! : `${agentNames.length} agents`;
  return `${machine} is ready. New work for ${who} now wakes ${agentNames.length === 1 ? 'it' : 'them'}.`;
}
