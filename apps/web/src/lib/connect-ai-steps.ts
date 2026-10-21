/**
 * #1003 — Connect your AI: ONE numbered set of steps per client, in plain words (the #871 design). Pure so the shape is
 * testable: a step is text with optional bold runs, plus an optional block that follows it — the connector NAME and the
 * server ADDRESS each with a Copy button.
 *
 * Hosted StoryOS uses OAuth: no token is created or pasted. The tokens path lives in "Advanced", not in the steps.
 */

export type ConnectClient = 'claude' | 'chatgpt';

/** A run of a step's text; `bold` marks the UI label the person will see on screen. */
export interface Run {
  text: string;
  bold?: boolean;
  muted?: boolean;
}
export type StepBlock = 'name' | 'addr';
export interface ConnectStep {
  runs: Run[];
  block?: StepBlock;
}

/** The connector name a person types into their AI client. Ievgen asked for it directly (ticket #1003). */
export const CONNECTOR_NAME = 'StoryOS';

const t = (text: string): Run => ({ text });
const b = (text: string): Run => ({ text, bold: true });
const m = (text: string): Run => ({ text, muted: true });

export const CONNECT_CLIENTS: Record<
  ConnectClient,
  { label: string; plans: string; reference: string; steps: (workspace: string) => ConnectStep[] }
> = {
  claude: {
    label: 'Claude',
    plans: 'Claude Pro, Max, Team and Enterprise',
    reference: 'https://support.anthropic.com/en/articles/11175166-about-custom-integrations-using-remote-mcp',
    steps: (ws) => [
      {
        runs: [
          t('In Claude, open '),
          b('Customize → Connectors'),
          t(', click '),
          b('+ Add'),
          t(', then '),
          b('Add custom connector'),
          t('. '),
          m('On Team and Enterprise, an owner adds it first under Organization settings → Connectors.'),
        ],
      },
      { runs: [t('In the name field, type:')], block: 'name' },
      { runs: [t('In the URL field, paste this address, then click '), b('Continue'), t(':')], block: 'addr' },
      {
        runs: [
          t('Leave sign-in as Claude suggests — '),
          b('Sign in now'),
          t(' and '),
          b('Use Claude’s published identity'),
          t(' — and click '),
          b('Add'),
          t('.'),
        ],
      },
      {
        runs: [
          t('Claude opens StoryOS — sign in and pick '),
          b(ws),
          t('. Then in a chat, click '),
          b('+ → Connectors'),
          t(' and switch StoryOS on.'),
        ],
      },
    ],
  },
  chatgpt: {
    label: 'ChatGPT',
    plans: 'ChatGPT Business, Enterprise and Edu, on the web',
    reference:
      'https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta',
    steps: (ws) => [
      {
        runs: [
          t('An admin turns on '),
          b('developer mode'),
          t(' first. Then open '),
          b('Settings → Apps'),
          t(' and click '),
          b('Create'),
          t('.'),
        ],
      },
      { runs: [t('In the name field, type:')], block: 'name' },
      { runs: [t('In the MCP server URL field, paste this address:')], block: 'addr' },
      {
        runs: [
          t('Choose '),
          b('OAuth'),
          t(', tick '),
          b('I trust this application'),
          t(', and click '),
          b('Create'),
          t('.'),
        ],
      },
      {
        runs: [
          t('Sign in to StoryOS when ChatGPT asks, and pick '),
          b(ws),
          t('. Then enable StoryOS in a new chat.'),
        ],
      },
    ],
  },
};

/** The step's text as plain words (for tests and for aria), runs joined. */
export const stepText = (s: ConnectStep) => s.runs.map((r) => r.text).join('');
