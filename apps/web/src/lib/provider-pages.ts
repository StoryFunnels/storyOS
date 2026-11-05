import { connectControl, type ConnectControl, type ProviderAvailability } from '@/lib/provider-availability';
import {
  connectionCardModel,
  type CardConnection,
  type CardModel,
  type ConnectionStatus,
} from '@/lib/connection-card';
import { presetForConnection, type CustomApiPreset, type CustomApiPresetId } from '@/lib/custom-api-presets';

/**
 * Ticket #1188 — every provider page, declared once.
 *
 * The Integrations hub, each provider page's connection card and the guard tests all read `PROVIDER_PAGES`, so a provider cannot have a
 * page without a card (and so without Disconnect), and the hub cannot list a provider whose page does not exist. This replaces a split
 * where Disconnect was on the hub for GitHub, Linear and Slack only, and on /connections for Google, YouTube and Shopify only.
 *
 * Three ways a provider is backed, because StoryOS has two credential stores that grew apart:
 *  - `connections`: the workspace credential registry (`/connections`, API `connections/providers/*`): Google, Shopify, email, HTTP...
 *  - `integration`: GitHub, Linear and Slack keep their credential in workspace settings behind their own endpoints.
 *  - `builtin`: Delegate to agent has no credential at all, so there is nothing to connect or disconnect.
 */
export type ProviderPageId =
  | 'github' | 'linear' | 'slack'
  | 'youtube' | 'google-calendar' | 'shopify'
  | 'email' | 'custom-api' | 'meta' | 'x' | 'linkedin'
  | 'apify' | 'openai'
  | 'delegate-agent';

export interface ConnectionRow {
  id: string;
  provider: string;
  name: string;
  status: ConnectionStatus;
  scopes: string[];
  last_ok_at: string | null;
  created_at: string;
  error_count_24h: number;
  breaker_open_until: string | null;
  base_url?: string | null;
  needs_base_url?: boolean;
}

export interface ProviderInfo {
  id: string;
  label: string;
  auth_kind: 'oauth2' | 'api_key' | 'smtp';
  tier?: 'api_key' | 'oauth_managed' | 'hosted_only';
  availability?: ProviderAvailability;
  availability_note?: string;
  oauth?: { scopes: string[]; configured: boolean };
}

/** What a provider's own config endpoint says; the API reports these as booleans plus the health its service already computes. */
export interface IntegrationFacts {
  connected: boolean;
  /** One sentence when something needs a person's attention (GitHub: repositories still sending events; Linear: a stale mirror). */
  problem?: string | null;
  /** One sentence of health when nothing is wrong (Linear: when it last synced). */
  detail?: string | null;
}

export type IntegrationEndpoint = 'github' | 'linear' | 'slack';

export interface ConnectChoice {
  providerId: string;
  label: string;
  /** Set on a Custom API preset: the connect form opens with that preset's name, base URL and docs. */
  presetId?: CustomApiPresetId;
}

export type Backing =
  | {
      kind: 'connections';
      /** Registry provider ids whose saved connections are this page's rows. */
      providers: readonly string[];
      /** Narrows or widens the rows (a preset page shows only the HTTP connections of that preset). */
      rowMatch?: (c: Pick<ConnectionRow, 'provider' | 'name'>) => boolean;
      connect: readonly ConnectChoice[];
      /** A second credential is normal here (Custom API), so Connect stays after the first. */
      addAnother?: boolean;
    }
  | {
      kind: 'integration';
      endpoint: IntegrationEndpoint;
      /**
       * `live`: Test calls the provider with the saved credential. `status`: StoryOS has no read-only live check for this provider
       * yet (a recorded gap on ticket #1188), so the button re-reads the health StoryOS already holds and says so.
       */
      test: 'live' | 'status';
    }
  | { kind: 'builtin' };

export interface ProviderPageDef {
  /** Route segment under /settings/integrations. */
  id: ProviderPageId;
  label: string;
  blurb: string;
  backing: Backing;
  /**
   * What stops when this is disconnected, in words, for the confirm dialog (the blast radius, named). Null only for a provider that
   * holds no credential.
   */
  disconnectEffect: string | null;
}

const isPreset = (id: CustomApiPresetId) => (c: Pick<ConnectionRow, 'provider' | 'name'>) => presetForConnection(c)?.id === id;

export const PROVIDER_PAGES: ReadonlyArray<ProviderPageDef> = [
  {
    id: 'github',
    label: 'GitHub',
    blurb: 'Pull requests and commits on your records',
    backing: { kind: 'integration', endpoint: 'github', test: 'live' },
    disconnectEffect:
      'Pull requests and issues stop syncing, and the saved token or installation and the watched repositories are cleared. Records and links already made stay.',
  },
  {
    id: 'linear',
    label: 'Linear',
    blurb: 'Teams, issues, sprints and projects mirrored into StoryOS',
    backing: { kind: 'integration', endpoint: 'linear', test: 'status' },
    disconnectEffect:
      'The scheduled mirror and comment write-back stop, and the saved API key and team filter are cleared. Issues already imported stay.',
  },
  {
    id: 'slack',
    label: 'Slack',
    blurb: 'Post to channels; notify on changes',
    backing: { kind: 'integration', endpoint: 'slack', test: 'live' },
    disconnectEffect:
      'Buttons and automations that post to Slack fail until you connect again. The saved bot token, webhook and default channel are cleared.',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    blurb: 'Videos, comments and metrics into a database',
    backing: { kind: 'connections', providers: ['google'], connect: [{ providerId: 'google', label: 'Connect YouTube' }] },
    disconnectEffect: 'Syncs from YouTube stop. Videos, comments and metrics already imported stay.',
  },
  {
    id: 'google-calendar',
    label: 'Google Calendar',
    blurb: 'Two-way sync between date fields and your calendar',
    backing: { kind: 'connections', providers: ['google-calendar'], connect: [{ providerId: 'google-calendar', label: 'Connect Google Calendar' }] },
    disconnectEffect: 'Calendar mappings stop syncing in both directions. Events and records already there stay.',
  },
  {
    id: 'shopify',
    label: 'Shopify',
    blurb: 'Orders and products into a database',
    backing: { kind: 'connections', providers: ['shopify'], connect: [{ providerId: 'shopify', label: 'Connect Shopify' }] },
    disconnectEffect: 'Syncs from Shopify stop, so the product catalogue stops updating. Databases and records already created stay.',
  },
  {
    id: 'email',
    label: 'Email',
    blurb: 'Send from your own domain (API key or SMTP)',
    backing: {
      kind: 'connections',
      providers: ['resend', 'smtp'],
      connect: [
        { providerId: 'resend', label: 'Connect Resend' },
        { providerId: 'smtp', label: 'Connect SMTP' },
      ],
      addAnother: true,
    },
    disconnectEffect: 'Send email buttons and automation actions that use this connection fail until you connect another.',
  },
  {
    id: 'custom-api',
    label: 'Custom API',
    blurb: 'Any HTTP API, plus presets for Meta, X and LinkedIn',
    // A saved connection whose name marks it as Meta, X or LinkedIn is shown on that preset's page, so each appears exactly once.
    backing: { kind: 'connections', providers: ['http'], rowMatch: (c) => !presetForConnection(c), connect: [{ providerId: 'http', label: 'Connect an API' }], addAnother: true },
    disconnectEffect: 'Every button, automation action or source that uses this connection stops working.',
  },
  {
    id: 'meta',
    label: 'Meta (Facebook & Instagram)',
    blurb: 'Custom API preset: Facebook Page and Instagram comments into a database',
    backing: {
      kind: 'connections',
      providers: ['http'],
      rowMatch: isPreset('meta'),
      connect: [{ providerId: 'http', label: 'Connect Meta', presetId: 'meta' }],
      addAnother: true,
    },
    disconnectEffect: 'Syncs from Meta stop. Comments already imported stay.',
  },
  {
    id: 'x',
    label: 'X (Twitter)',
    blurb: 'Custom API preset: mentions of your X account into a database',
    // Rows also include the dedicated `x` provider (made through the API for posting): its connect form cannot be offered, because
    // the generic API-key form sends `api_key` and the X provider checks `access_token`, so the connect would only ever fail.
    backing: {
      kind: 'connections',
      providers: ['http', 'x'],
      rowMatch: (c) => c.provider === 'x' || isPreset('x')(c),
      connect: [{ providerId: 'http', label: 'Connect X', presetId: 'x' }],
      addAnother: true,
    },
    disconnectEffect: 'Syncs from X stop, and anything else that uses this connection, such as posting to X, stops working. Mentions already imported stay.',
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    blurb: 'Custom API preset: comments on your organization posts',
    backing: {
      kind: 'connections',
      providers: ['http', 'linkedin'],
      rowMatch: (c) => c.provider === 'linkedin' || isPreset('linkedin')(c),
      connect: [
        { providerId: 'http', label: 'Connect with a token', presetId: 'linkedin' },
        { providerId: 'linkedin', label: 'Connect LinkedIn' },
      ],
      addAnother: true,
    },
    disconnectEffect: 'Syncs from LinkedIn stop, and anything else that uses this connection, such as posting to LinkedIn, stops working. Comments already imported stay.',
  },
  {
    id: 'apify',
    label: 'Apify',
    blurb: 'Scrapers and actors as a source',
    backing: { kind: 'connections', providers: ['apify'], connect: [{ providerId: 'apify', label: 'Connect Apify' }] },
    disconnectEffect: 'Apify sources stop syncing. Records already imported stay.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    blurb: 'Your own OpenAI key for Tyron',
    backing: { kind: 'connections', providers: ['openai'], connect: [{ providerId: 'openai', label: 'Connect OpenAI' }] },
    disconnectEffect: 'Tyron stops using your own OpenAI key until you connect one again.',
  },
  {
    id: 'delegate-agent',
    label: 'Delegate to agent',
    blurb: 'Hand a record to an outside agent',
    backing: { kind: 'builtin' },
    disconnectEffect: null,
  },
];

export function providerPage(id: string): ProviderPageDef | undefined {
  return PROVIDER_PAGES.find((p) => p.id === id);
}

/** Where a provider's page lives, for links from anywhere. */
export function providerPageHref(ws: string, id: ProviderPageId): string {
  return `/w/${ws}/settings/integrations/${id}`;
}

/** The provider ids a page's rows can come from, across every def: the guard test checks this covers the API's registry. */
export function coveredConnectionProviders(): Set<string> {
  const out = new Set<string>();
  for (const p of PROVIDER_PAGES) if (p.backing.kind === 'connections') for (const id of p.backing.providers) out.add(id);
  return out;
}

export interface SnapshotInput {
  connections: ConnectionRow[];
  providers: ProviderInfo[];
  integrations: Partial<Record<IntegrationEndpoint, IntegrationFacts>>;
  /** Formats a timestamp for the viewer (`useDateFormat().dateTime`), so the pure builder never guesses a locale. */
  formatDateTime: (iso: string) => string;
}

export interface CardRow {
  key: string;
  /** The saved connection's id; null for an integration (one per workspace). */
  connectionId: string | null;
  name: string;
  subtitle: string | null;
  model: CardModel;
  preset: CustomApiPreset | null;
  connection: ConnectionRow | null;
  /** Resume and the technical details that sit under "Advanced". */
  advanced: { errorCount24h: number; breakerOpenUntil: string | null; baseUrl: string | null; needsBaseUrl: boolean; bounceWebhook: boolean };
}

export interface ConnectOptionView {
  providerId: string;
  label: string;
  presetId?: CustomApiPresetId;
  control: ConnectControl;
  availability: ProviderAvailability;
  /** The reason a connect control is absent or disabled, written out, never a tooltip. */
  note: string | null;
  /** The catalog entry behind this choice (absent until the catalog has loaded, or for an integration). */
  info?: ProviderInfo;
}

export interface PageSnapshot {
  def: ProviderPageDef;
  rows: CardRow[];
  connect: ConnectOptionView[];
  /** The page in one verdict: the hub's pill. */
  overall: CardModel;
}

const BUILTIN_MODEL: CardModel = { state: 'connected', pill: { tone: 'ok', label: 'Built in' }, summary: 'Built in: there is nothing to connect.', actions: [] };

/** A saved connection's own name, with the one historical rename: Google's connection is called YouTube. */
export function connectionDisplayName(c: Pick<ConnectionRow, 'provider' | 'name'>): string {
  return c.provider === 'google' && c.name === 'Google' ? 'YouTube' : c.name;
}

function rowFromConnection(c: ConnectionRow, info: ProviderInfo | undefined, fmt: (iso: string) => string): CardRow {
  const card: CardConnection = {
    status: c.status,
    errorCount24h: c.error_count_24h,
    breakerOpenUntil: c.breaker_open_until,
    needsBaseUrl: c.provider === 'http' && c.needs_base_url === true,
  };
  return {
    key: c.id,
    connectionId: c.id,
    name: connectionDisplayName(c),
    subtitle: c.last_ok_at ? `Last checked ${fmt(c.last_ok_at)}` : null,
    model: connectionCardModel({ availability: info?.availability ?? 'connectable', connection: card, oauth: info?.auth_kind === 'oauth2' }),
    preset: presetForConnection(c),
    connection: c,
    advanced: {
      errorCount24h: c.error_count_24h,
      breakerOpenUntil: c.breaker_open_until,
      baseUrl: c.provider === 'http' ? (c.base_url ?? null) : null,
      needsBaseUrl: card.needsBaseUrl === true,
      bounceWebhook: c.provider === 'resend' && c.scopes.some((s) => s.startsWith('from:')),
    },
  };
}

/** Folds the worst row into one verdict: any row needing attention makes the page need attention. */
function overallOf(rows: CardRow[], connect: ConnectOptionView[]): CardModel {
  if (rows.length > 0) {
    return rows.find((r) => r.model.state === 'needs_attention')?.model ?? rows[0]!.model;
  }
  if (connect.some((c) => c.control !== 'none')) {
    return connectionCardModel({ availability: 'connectable', connection: null });
  }
  // Nothing can be connected here. Say the most helpful true thing: an operator can turn it on beats "cloud only".
  const first = connect.find((c) => c.availability === 'operator_config') ?? connect[0];
  const info = first ?? { availability: 'connectable' as ProviderAvailability, note: null };
  return connectionCardModel({ availability: info.availability, availabilityNote: info.note ?? undefined, connection: null });
}

/**
 * One provider page's state, from the three reads the Integrations hub already makes (the credential list, the provider catalog, and
 * each integration's own config). Pure, so the hub and the page's card can never disagree about it and so each state is testable.
 */
export function providerPageSnapshot(def: ProviderPageDef, input: SnapshotInput): PageSnapshot {
  const b = def.backing;
  if (b.kind === 'builtin') return { def, rows: [], connect: [], overall: BUILTIN_MODEL };

  if (b.kind === 'integration') {
    const facts = input.integrations[b.endpoint];
    const rows: CardRow[] = [];
    if (facts?.connected) {
      rows.push({
        key: def.id,
        connectionId: null,
        name: def.label,
        subtitle: facts.detail ?? null,
        model: connectionCardModel({ availability: 'connectable', connection: { status: 'active', problem: facts.problem ?? null } }),
        preset: null,
        connection: null,
        advanced: { errorCount24h: 0, breakerOpenUntil: null, baseUrl: null, needsBaseUrl: false, bounceWebhook: false },
      });
    }
    const connect: ConnectOptionView[] = [
      { providerId: def.id, label: `Connect ${def.label}`, control: 'none', availability: 'connectable', note: null },
    ];
    return { def, rows, connect, overall: rows[0]?.model ?? connectionCardModel({ availability: 'connectable', connection: null }) };
  }

  const infoById = new Map(input.providers.map((p) => [p.id, p]));
  const matches = b.rowMatch ?? ((c: Pick<ConnectionRow, 'provider' | 'name'>) => b.providers.includes(c.provider));
  const rows = input.connections.filter((c) => b.providers.includes(c.provider) && matches(c)).map((c) => rowFromConnection(c, infoById.get(c.provider), input.formatDateTime));
  const connect: ConnectOptionView[] = b.connect.map((choice) => {
    const info = infoById.get(choice.providerId);
    const availability = info?.availability ?? 'connectable';
    const control: ConnectControl = info ? connectControl(availability, info.auth_kind, info.id) : 'none';
    return { providerId: choice.providerId, label: choice.label, presetId: choice.presetId, control, availability, note: info?.availability_note ?? null, info };
  });
  return { def, rows, connect, overall: overallOf(rows, connect) };
}

/** Whether a page needs a person to look at it (used for the hub's count and sort). */
export function pageNeedsAttention(s: PageSnapshot): boolean {
  return s.rows.some((r) => r.model.state === 'needs_attention');
}
