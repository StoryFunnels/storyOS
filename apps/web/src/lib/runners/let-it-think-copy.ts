import type { SettingsConfirm } from '@/lib/settings-confirmations';

/**
 * Ticket #1210 (Vera's send-back) — the plain words for moving an agent between running without an AI and thinking with the
 * person's own AI. One module so the wording is testable and the page cannot invent its own. The two things a person must know
 * before agreeing are COST (never metered on StoryOS: their own subscription, their own computer) and PRIVACY (the record content
 * the agent works on is sent to their own AI), and that the switch does not start a run by itself.
 */
export function confirmLetItThink(agentName: string): SettingsConfirm {
  return {
    title: `Let ${agentName} think with your AI?`,
    message:
      `${agentName} will start using your own AI. ` +
      'Cost: it is never metered on StoryOS. It runs on your own subscription, on your own computer. ' +
      'Privacy: the record content it works on goes to your own AI. ' +
      'This does not start a run by itself.',
    confirmLabel: 'Let it think with my AI',
    danger: false,
  };
}

/** The Advanced section's switch-back control. */
export const RUN_WITHOUT_AI = {
  heading: 'AI mode',
  note: 'It thinks with your own AI now. Run it without an AI and it goes back to running its steps without one, and stops using your Runner.',
  button: 'Run without an AI',
  pending: 'Switching…',
} as const;

export function runWithoutAiToast(agentName: string): string {
  return `${agentName} now runs its steps without an AI.`;
}
