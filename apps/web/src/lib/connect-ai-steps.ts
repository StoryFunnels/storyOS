/**
 * #1003 — Connect your AI: ONE numbered set of steps per client, in plain words (the #871 design). Pure so the shape is
 * testable: a step is text with optional bold runs, plus an optional block that follows it — the connector NAME and the
 * server ADDRESS each with a Copy button.
 *
 * Hosted StoryOS uses OAuth: no token is created or pasted. The tokens path lives in "Advanced", not in the steps — except for
 * "Other" (#988), the honest path for any client we have not written a guide for: it gives the generic server address and
 * names BOTH ways in, OAuth first and a token for a client that cannot open a sign-in page.
 *
 * Codex, Cursor and Gemini CLI are not here on purpose: a guide nobody followed against the real client is a dead end, so each
 * waits until a person has tested it and the tested version can be noted.
 */

export type ConnectClient = 'claude' | 'chatgpt' | 'other';

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

/**
 * #1057 — the "Try asking it" examples on the connected card. They are what a CUSTOMER would say, and they must work on
 * ANY workspace: none names a database, a person, a customer or a ticket (the page once shipped the team's own dogfooding
 * prompt). Prefer ones that read the person's own data, so the first answer is theirs.
 */
export const TRY_ASKING: readonly string[] = [
  'What’s waiting for me in StoryOS?',
  'Show me what’s overdue this week',
  'Create a task for the kickoff meeting and assign it to me',
];

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
  other: {
    label: 'Other',
    plans: 'Any app or command-line tool that can connect to a remote MCP server over HTTPS',
    reference: 'https://modelcontextprotocol.io/',
    steps: (ws) => [
      {
        runs: [
          t('In your AI app, open where it adds a '),
          b('remote MCP server'),
          t(' — it may be called a connector, a custom connector or an MCP server. '),
          m('It has to support remote servers (streamable HTTP). A tool that can only run a local command cannot use this address.'),
        ],
      },
      { runs: [t('In the name field, type:')], block: 'name' },
      { runs: [t('In the server URL field, paste this address:')], block: 'addr' },
      {
        runs: [
          t('If it asks how to sign in, choose '),
          b('OAuth'),
          t(' (recommended). StoryOS opens a page asking you to allow it: choose the workspace it may reach and whether it can '),
          b('read only'),
          t(' or '),
          b('read and write'),
          t(', then click '),
          b('Allow'),
          t('.'),
        ],
      },
      {
        runs: [
          t('If your app cannot open a sign-in page, use a token instead: create one under '),
          b('Settings → API tokens'),
          t(' (it is shown once) and send it as '),
          b('Authorization: Bearer …'),
          t(' with the address above. '),
          m('Never paste a token into a sign-in page.'),
        ],
      },
      {
        runs: [
          t('That’s it. It can reach only the workspace you chose on the Allow page ('),
          b(ws),
          t(' here). To check, ask it: “What’s waiting for me in StoryOS?”'),
        ],
      },
    ],
  },
};

/** The step's text as plain words (for tests and for aria), runs joined. */
export const stepText = (s: ConnectStep) => s.runs.map((r) => r.text).join('');
