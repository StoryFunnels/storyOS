import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SlackApiFetcher } from '../../src/integrations/slack-api';

/** One request the fake Slack received, exactly as it arrived on the wire. */
export interface SlackWireCall {
  /** `auth.test`, `chat.unfurl`: the path after `/api/`. */
  method: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Record<string, unknown>;
}

/**
 * Ticket #1379 - a MOCKED SLACK: a real HTTP server on a loopback port that speaks the two Web API methods the link-preview path
 * calls (`auth.test`, `chat.unfurl`), with Slack's own response shapes and error codes. `fetcher` is what a test assigns to
 * `SlackApiClient.fetcher`: it sends the request over real HTTP to this server, so what we assert on is what would be on the wire
 * (method path, Authorization header, content type, JSON body), not a call into our own code.
 *
 * It never touches slack.com; the production fetcher (guarded, pinned to slack.com) is covered separately in `slack-api.test.ts`.
 */
export class FakeSlack {
  /** bot token -> the Slack team (workspace) it belongs to. A token not listed is `invalid_auth`, as with Slack. */
  readonly tokens = new Map<string, string>();
  readonly calls: SlackWireCall[] = [];
  /** Set to make `chat.unfurl` answer `{ ok: false, error }`. */
  unfurlError: string | null = null;
  private server: Server | null = null;
  private port = 0;

  /** The calls of one method, newest last. */
  of(method: 'auth.test' | 'chat.unfurl'): SlackWireCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  reset(): void {
    this.calls.length = 0;
    this.unfurlError = null;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const method = (req.url ?? '').replace(/^\/api\//, '');
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
        } catch {
          /* a malformed body is recorded as empty and answered like Slack would */
        }
        this.calls.push({ method, authorization: req.headers.authorization, contentType: req.headers['content-type'], body });
        const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        const team = this.tokens.get(token);
        const reply = (json: Record<string, unknown>) => {
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(json));
        };
        if (!team) return reply({ ok: false, error: 'invalid_auth' });
        if (method === 'auth.test') return reply({ ok: true, team_id: team, team: 'Test Team', url: 'https://example.slack.com/' });
        if (method === 'chat.unfurl') {
          if (this.unfurlError) return reply({ ok: false, error: this.unfurlError });
          const hasTarget = (typeof body.channel === 'string' && typeof body.ts === 'string') || (typeof body.unfurl_id === 'string' && typeof body.source === 'string');
          if (!hasTarget) return reply({ ok: false, error: 'invalid_arguments' });
          if (!body.unfurls || typeof body.unfurls !== 'object') return reply({ ok: false, error: 'invalid_arguments' });
          return reply({ ok: true });
        }
        return reply({ ok: false, error: 'unknown_method' });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  readonly fetcher: SlackApiFetcher = async (method, token, body) => {
    const res = await fetch(`http://127.0.0.1:${this.port}/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  };
}
