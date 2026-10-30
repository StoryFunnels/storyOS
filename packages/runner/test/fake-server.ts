// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { ClaimedWake, CompleteRequest } from '../src/protocol/types.js';

/**
 * A fake StoryOS server speaking the /api/v1/runner/v1 contract, as read from the server's controllers on the Runner stack
 * (apps/api/src/runners/runner-api.controller.ts and its services). It is deliberately a SEPARATE implementation from the Runner:
 * the Runner's tests prove it against this, and `test/contract.test.ts` proves the request shapes against the server's openapi.
 *
 * Fault injection is by plain properties, so each test says what goes wrong in one line.
 */
export interface FakeWake {
  id: string;
  agentId: string;
  agentName: string;
  status: 'queued' | 'claimed' | 'done' | 'failed' | 'canceled';
  nonce: string | null;
  attempts: number;
  recordId: string | null;
  completions: CompleteRequest[];
  claims: number;
}

export interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
  authorized: boolean;
}

export const TOKEN = 'mn_run_FAKE0123456789abcdefghijklmnopqrstuvwx';
export const CODE = 'K7M2QX';

export class FakeServer {
  server!: Server;
  url = '';
  workspaceId = '8f1c2a52-0b7c-4a9e-8e53-3a6f0c1d2b11';
  runnerStatus: 'pending' | 'active' | 'revoked' = 'pending';
  revokedReason: string | null = null;
  chosenTool: string | null = 'claude-code';
  wakes = new Map<string, FakeWake>();
  calls: Call[] = [];
  paired = false;
  codeState: 'live' | 'used' | 'cancelled' | 'expired' = 'live';

  // ---- fault injection
  /** Destroy the socket on the next N claim calls, while the long poll is open. */
  dropClaims = 0;
  /** Apply the next N completions, then destroy the socket instead of answering (the response is lost, the write is not). */
  dropCompleteResponses = 0;
  /** Destroy the socket before applying the next N completions (the request is lost). */
  dropCompleteRequests = 0;
  /** What the per-wake lease heartbeat does. */
  leaseMode: 'ok' | 'lost' | 'down' = 'ok';
  /** Answer every authenticated call with this status and error code. */
  forceError: { status: number; code: string; meta?: Record<string, unknown> } | null = null;
  leaseSeconds = 90;
  heartbeatSeconds = 30;
  pausedUntil = 0;
  /** Called synchronously at the moment a completion arrives, before it is recorded (lets a test look at the Runner's disk at that instant). */
  onCompletion: ((wake: FakeWake) => void) | null = null;

  async listen(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ---- what the person does in the app
  pressDone(): void {
    if (this.runnerStatus === 'pending') this.runnerStatus = 'active';
  }
  cancelPairing(): void {
    this.runnerStatus = 'revoked';
    this.revokedReason = 'cancelled';
  }
  enqueue(partial: Partial<FakeWake> = {}): FakeWake {
    const wake: FakeWake = {
      id: randomUUID(),
      agentId: randomUUID(),
      agentName: 'Sales assistant',
      status: 'queued',
      nonce: null,
      attempts: 0,
      recordId: randomUUID(),
      completions: [],
      claims: 0,
      ...partial,
    };
    this.wakes.set(wake.id, wake);
    return wake;
  }
  /** The reaper: a claimed wake whose lease lapsed goes back to the queue and forgets its nonce. */
  expireLease(id: string): void {
    const w = this.wakes.get(id);
    if (w && w.status === 'claimed') {
      w.status = 'queued';
      w.nonce = null;
      w.attempts += 1;
    }
  }
  callsTo(pathPart: string): Call[] {
    return this.calls.filter((c) => c.path.includes(pathPart));
  }
  allCompletions(): CompleteRequest[] {
    return [...this.wakes.values()].flatMap((w) => w.completions);
  }

  // ---- the contract
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (c: Buffer) => (data += c.toString()));
      req.on('end', () => resolve(data));
    });
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const path = (req.url ?? '').replace('/api/v1/runner/v1', '');
    const authorized = req.headers.authorization === `Bearer ${TOKEN}`;
    this.calls.push({ method: req.method ?? '', path, body, authorized });

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const fail = (status: number, code: string, message: string, meta?: Record<string, unknown>) =>
      json(status, { error: { code, message, ...(meta ? { meta } : {}), request_id: 'req_fake' } });

    if (path === '/pair') {
      const code = String(body.code ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
      if (code !== CODE) return fail(422, 'invalid_code', 'That code is not valid.');
      if (this.codeState === 'cancelled') return fail(409, 'pairing_cancelled', 'The pairing was cancelled in StoryOS. Run `storyos-runner pair` again.');
      if (this.codeState === 'expired') return fail(409, 'pairing_expired', 'The pairing window ended before you pressed Done in StoryOS.');
      if (this.codeState === 'used') return fail(409, 'code_already_used', 'That code was already used.');
      this.codeState = 'used';
      this.paired = true;
      return json(201, {
        token: TOKEN,
        runner: { id: 'runner-1', status: 'pending', name: String(body.machine_name) },
        workspace_id: this.workspaceId,
        pending_expires_at: new Date(Date.now() + 600_000).toISOString(),
        protocol: { minimum: 1, maximum: 1 },
      });
    }

    if (!authorized) return fail(401, 'invalid_runner_token', 'Invalid Runner token. Pair this Runner again.');
    if (this.runnerStatus === 'revoked') {
      return fail(401, 'runner_revoked', 'This Runner was removed in StoryOS.', { reason: this.revokedReason });
    }
    if (this.forceError) return fail(this.forceError.status, this.forceError.code, 'forced', this.forceError.meta);

    if (path === '/heartbeat') {
      return json(200, {
        runner: { id: 'runner-1', status: this.runnerStatus, chosen_tool: this.chosenTool, name: String(body.machine_name) },
        protocol: { minimum: 1, maximum: 1, current: 1 },
        server_time: new Date().toISOString(),
        heartbeat_interval_seconds: 30,
        offline_after_seconds: 120,
        assigned_agents: this.runnerStatus === 'active' ? [{ id: 'agent-1', name: 'Sales assistant' }] : [],
      });
    }

    if (path === '/claim') {
      const waitMs = Math.min(Number(body.wait_seconds ?? 25), 25) * 1000;
      const max = Number(body.max ?? 1);
      // A Runner whose tool hit its limit is paused: nothing is handed out until the time passes (runners.paused_until).
      const paused = this.pausedUntil > Date.now();
      if (this.dropClaims > 0) {
        this.dropClaims -= 1;
        // Hold the poll open for a moment, then cut the connection under the Runner.
        setTimeout(() => req.socket.destroy(), 80);
        return;
      }
      const until = Date.now() + waitMs;
      // A client that hung up must not claim anything afterwards: the wake would be marked claimed and delivered to nobody.
      let gone = false;
      req.socket.once('close', () => (gone = true));
      const tick = (): void => {
        if (gone || res.destroyed || req.socket.destroyed) return;
        const taken: ClaimedWake[] = [];
        if (this.runnerStatus === 'active' && !paused) {
          for (const w of this.wakes.values()) {
            if (taken.length >= max) break;
            if (w.status !== 'queued') continue;
            w.status = 'claimed';
            w.nonce = randomUUID();
            w.claims += 1;
            taken.push(this.present(w));
          }
        }
        if (taken.length > 0) return json(200, { wakes: taken, protocol: { minimum: 1, maximum: 1 } });
        if (Date.now() >= until) {
          res.writeHead(204);
          return void res.end();
        }
        setTimeout(tick, 20);
      };
      return tick();
    }

    const lease = /^\/wakes\/([^/]+)\/heartbeat$/.exec(path);
    if (lease) {
      const w = this.wakes.get(decodeURIComponent(lease[1]!));
      if (this.leaseMode === 'down') return void req.socket.destroy();
      if (this.leaseMode === 'lost' || !w || w.status !== 'claimed' || w.nonce !== body.nonce) {
        return fail(409, 'lease_lost', 'This Runner no longer holds that wake.', { wake_id: lease[1] });
      }
      return json(200, { wake_id: w.id, lease_expires_at: new Date(Date.now() + this.leaseSeconds * 1000).toISOString(), lease_seconds: this.leaseSeconds });
    }

    const done = /^\/wakes\/([^/]+)\/complete$/.exec(path);
    if (done) {
      const w = this.wakes.get(decodeURIComponent(done[1]!));
      if (this.dropCompleteRequests > 0) {
        this.dropCompleteRequests -= 1;
        return void req.socket.destroy();
      }
      if (!w || w.nonce === null || w.nonce !== body.nonce) return fail(409, 'lease_lost', 'This Runner no longer holds that wake.', { wake_id: done[1] });
      if (w.status !== 'claimed') return json(200, { wake_id: w.id, status: w.status, requeued: w.status === 'queued', repeated: true });
      const c = body as unknown as CompleteRequest;
      this.onCompletion?.(w);
      w.completions.push(c);
      if (c.exit === 'limit_reached' && c.limit_reached_until) this.pausedUntil = Date.parse(c.limit_reached_until);
      w.status = c.exit === 'ok' ? 'done' : c.exit === 'limit_reached' ? 'queued' : c.exit === 'aborted' ? 'canceled' : 'failed';
      if (this.dropCompleteResponses > 0) {
        this.dropCompleteResponses -= 1;
        return void req.socket.destroy();
      }
      return json(200, { wake_id: w.id, status: w.status, requeued: w.status === 'queued', repeated: false });
    }

    return fail(404, 'not_found', 'Not found');
  }

  private present(w: FakeWake): ClaimedWake {
    return {
      id: w.id,
      nonce: w.nonce!,
      lease_expires_at: new Date(Date.now() + this.leaseSeconds * 1000).toISOString(),
      lease_seconds: this.leaseSeconds,
      heartbeat_seconds: this.heartbeatSeconds,
      reason: 'manual',
      reasons: [{ reason: 'manual', count: 1 }],
      depth: 0,
      run_id: randomUUID(),
      agent: { id: w.agentId, name: w.agentName, goal: 'Keep the pipeline moving', instructions: 'Reply to the lead.', skills: null, target_databases: null },
      record: w.recordId ? { id: w.recordId, database_id: randomUUID(), number: 42 } : null,
      context: null,
      credential: { token: `agt_RUNCRED_${w.id.slice(0, 8)}_secretsecret`, scope: 'write', expires_at: new Date(Date.now() + this.leaseSeconds * 1000).toISOString() },
    };
  }
}
