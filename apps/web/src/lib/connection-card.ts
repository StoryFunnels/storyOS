import { presentAvailability, type ProviderAvailability } from '@/lib/provider-availability';

/**
 * Ticket #1188 — the ONE connection card every provider page renders: connect, test, disconnect, and a health line.
 *
 * It is a pure function of a few facts so the five states can be tested without a browser, and so no provider page can invent its
 * own: before this, Disconnect lived on the hub for GitHub, Linear and Slack, and only on /connections for Google, YouTube and
 * Shopify, because each page drew its own connect section.
 *
 * Two rules the model enforces, both from the integration-tier design (docs/architecture/integration-tiers.md):
 *  - `operator_config` and `cloud_only` are INFORMATION, never a button: a Connect that fails is worse than none.
 *  - A connection that already exists wins over the availability verdict: a credential saved before the operator removed the env vars
 *    can still be tested and disconnected, so Disconnect is present whenever there is something to disconnect.
 */
export type ConnectionCardState = 'connected' | 'needs_attention' | 'not_connected' | 'operator_config' | 'cloud_only';
export type CardActionId = 'connect' | 'test' | 'reconnect' | 'disconnect';
export type PillTone = 'ok' | 'warn' | 'bad' | 'quiet';

export type ConnectionStatus = 'active' | 'expired' | 'revoked' | 'error';

/** What is known about one saved credential. Absent means nothing is connected. */
export interface CardConnection {
  status: ConnectionStatus;
  /** Provider-specific trouble the status alone does not show (GitHub: repositories still sending events; Linear: a stale mirror). */
  problem?: string | null;
  errorCount24h?: number;
  breakerOpenUntil?: string | null;
  /** An HTTP connection saved before base URLs existed: it sends nothing until one is set. */
  needsBaseUrl?: boolean;
}

export interface CardInput {
  availability: ProviderAvailability;
  availabilityNote?: string;
  /** The saved credentials for this provider; empty when none. A card with several (Custom API) is a card per row. */
  connection: CardConnection | null;
  /** OAuth providers can be reconnected; an API key is replaced by connecting again, not "reconnected". */
  oauth?: boolean;
}

export interface CardModel {
  state: ConnectionCardState;
  pill: { tone: PillTone; label: string };
  /** The one line under the title: the problem if there is one, otherwise what the state means. */
  summary: string;
  actions: CardActionId[];
}

/** Whether a saved credential needs a person to look at it. */
export function needsAttention(c: CardConnection): boolean {
  return (
    c.status !== 'active' ||
    Boolean(c.problem) ||
    (c.errorCount24h ?? 0) > 0 ||
    Boolean(c.breakerOpenUntil) ||
    c.needsBaseUrl === true
  );
}

const STATUS_WORD: Record<ConnectionStatus, string> = {
  active: 'Working',
  expired: 'Expired',
  revoked: 'Revoked',
  error: 'Not working',
};

export function connectionCardModel(input: CardInput): CardModel {
  const { connection } = input;
  if (!connection) {
    const present = presentAvailability(input.availability, input.availabilityNote);
    if (!present.actionable) {
      return {
        state: present.state === 'cloud_only' ? 'cloud_only' : 'operator_config',
        pill: { tone: 'quiet', label: present.label },
        summary: present.description,
        actions: [],
      };
    }
    return { state: 'not_connected', pill: { tone: 'quiet', label: 'Not connected' }, summary: 'Not connected yet.', actions: ['connect'] };
  }

  const attention = needsAttention(connection);
  const actions: CardActionId[] = ['test'];
  // Reconnect is an OAuth redirect: where the operator has not configured the OAuth app it can only fail, so it is not offered.
  if (input.oauth && connection.status !== 'active' && input.availability === 'connectable') actions.push('reconnect');
  actions.push('disconnect');

  if (!attention) {
    return { state: 'connected', pill: { tone: 'ok', label: STATUS_WORD.active }, summary: 'Working.', actions };
  }
  const summary =
    connection.problem ??
    (connection.needsBaseUrl
      ? 'Set this connection’s base URL: until then it sends nothing, and rules that use it fail.'
      : connection.breakerOpenUntil
        ? 'Paused after repeated failures. Resume it once the cause is fixed.'
        : (connection.errorCount24h ?? 0) > 0
          ? `${connection.errorCount24h} ${connection.errorCount24h === 1 ? 'job' : 'jobs'} failed in the last 24 hours.`
          : input.oauth
            ? `${STATUS_WORD[connection.status]}: reconnect it to keep it working.`
            : `${STATUS_WORD[connection.status]}: check the key, or connect it again.`);
  // `bad` is for a credential that has stopped working; `warn` is for one that works but wants a look.
  const tone: PillTone = connection.status === 'active' ? 'warn' : 'bad';
  return {
    state: 'needs_attention',
    pill: { tone, label: connection.status === 'active' ? 'Needs a look' : STATUS_WORD[connection.status] },
    summary,
    actions,
  };
}
