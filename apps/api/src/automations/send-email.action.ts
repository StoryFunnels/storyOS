import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { and, eq, gte, inArray } from 'drizzle-orm';
import type { AutomationAction } from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { automationJobs, notifications } from '../db/schema';
import { EntitlementsService } from '../billing/entitlements.service';
import { ConnectionsService } from '../connections/connections.service';
import type { ResendAuth } from '../connections/providers/resend';
import type { SmtpConnectionAuth } from '../connections/providers/smtp';
import { NotificationsService } from '../notifications/notifications.service';
import { escapeHtml, renderBrandedEmail } from '../mail/templates';
import { RESEND_ENDPOINT, buildSmtpTransport } from '../mail/mail-driver';
import { ProviderError } from '../common/provider-error';
import { JobRunnerService } from './job-runner.service';
import type { JobHelpers } from './job-runner.service';

type SendEmailAction = Extract<AutomationAction, { type: 'send_email' }>;

/** Mirrors actions.service.ts's own job payload `ctx` shape (see execute()'s
 * queued-job branch) — this is what actually lands in `payload.ctx`. */
interface SendEmailCtx {
  workspaceId: string;
  databaseId: string;
  recordId: string | null;
  actorId: string;
  depth?: number;
}

/** Comma-split + trim + drop empties + a loose email-shape check — a full
 * RFC 5322 validator is overkill for "did a token render into something that
 * looks like an address"; the provider is the real source of truth on
 * deliverability. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 5;

function parseAddresses(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

function todayStartUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * A dependency-free markdown-lite renderer (MN-256). The implementation
 * guide suggested pulling in `marked`, but nothing in this repo (web included
 * — checked before adding a dependency) already depends on it, and a
 * send_email body is short admin-authored copy, not an arbitrary document:
 * paragraphs, bold/italic emphasis, inline code, and [text](url) links cover
 * every realistic template. Escapes the source FIRST — by the time this
 * runs, {Field}/{payload} tokens are already substituted in
 * (actions.service.ts's interpolate()) and may carry arbitrary record data —
 * then layers trusted, static HTML tags on top of the now-safe text.
 */
export function markdownToHtml(markdown: string): string {
  const blocks = markdown.split(/\n{2,}/).map((block) => {
    let html = escapeHtml(block.trim()).replace(/\n/g, '<br>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    return `<p style="margin: 0 0 12px;">${html}</p>`;
  });
  return blocks.join('\n');
}

/**
 * MN-256 — the send_email automation action's executor, registered with
 * MN-253's JobRunnerService the same way AgentsService registers run_agent
 * (see its own onModuleInit doc). Reached ONLY through the durable queue —
 * actions.service.ts's execute() already rendered every {Field}/{payload}
 * token before enqueueing (or before an approval snapshot froze), so
 * everything here is already-resolved strings; this never touches
 * interpolation itself.
 */
@Injectable()
export class SendEmailActionService implements OnModuleInit {
  private readonly logger = new Logger(SendEmailActionService.name);
  /** Swappable in tests, mirrors ConnectionsService.fetcher/smtpProvider's own
   * seam — the SMTP transport a send actually goes out through. */
  buildTransport = buildSmtpTransport;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly jobs: JobRunnerService,
    private readonly connections: ConnectionsService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.jobs.registerExecutor('send_email', (payload, helpers) => this.execute(payload, helpers), {
      timeoutClass: 'short',
    });
  }

  /** Public (not just the registered closure) so tests drive it directly with
   * a stub `helpers.connectionAuth`, the same way run-agent-automation.test.ts
   * swaps AgentsService.runtimeFor instead of going through a real provider. */
  async execute(payload: Record<string, unknown>, helpers: JobHelpers): Promise<{ message_id: string }> {
    const action = payload['action'] as SendEmailAction;
    const ctx = payload['ctx'] as SendEmailCtx;

    await this.enforceDailyCap(ctx.workspaceId, ctx.actorId);

    const to = parseAddresses(action.to);
    const cc = parseAddresses(action.cc);
    const all = [...to, ...cc];
    if (all.length === 0) {
      throw new ProviderError('send_email rendered no recipients — check the "to" template', {
        retryable: false,
      });
    }
    if (all.length > MAX_RECIPIENTS) {
      throw new ProviderError(
        `send_email allows at most ${MAX_RECIPIENTS} recipients (to + cc); got ${all.length}`,
        { retryable: false },
      );
    }
    const invalid = all.filter((a) => !EMAIL_RE.test(a));
    if (invalid.length > 0) {
      throw new ProviderError(`send_email rendered an invalid address: ${invalid.join(', ')}`, {
        retryable: false,
      });
    }

    const { provider, auth } = await helpers.connectionAuth(action.connection_id);
    const bodyHtml = markdownToHtml(action.body_markdown);
    const html = renderBrandedEmail({
      heading: escapeHtml(action.subject),
      bodyHtml,
      preheader: escapeHtml(action.subject),
    });
    const text = action.body_markdown;

    const messageId =
      provider === 'resend'
        ? await this.sendViaResend(auth as Partial<ResendAuth>, to, cc, action, html, text)
        : provider === 'smtp'
          ? await this.sendViaSmtp(auth as Partial<SmtpConnectionAuth>, to, cc, action, html, text)
          : (() => {
              throw new ProviderError(`connection provider "${provider}" cannot send email`, {
                retryable: false,
              });
            })();

    return { message_id: messageId };
  }

  /**
   * Step 4's daily cap: count today's succeeded+running send_email jobs for
   * the workspace (this job itself is already 'running' by the time the
   * executor runs — JobRunnerService.processClaimedJob flips it before
   * calling in — so it counts itself as today's Nth send, which is exactly
   * what makes a `cap`-sized workspace's cap-th send the last one to
   * succeed). Over cap: a non-retryable failure (retrying can't make room)
   * plus an Inbox notice — deliberately deduped to once/24h by hand (a plain
   * query against `notifications`, not NotificationsService's own 60s
   * burst-collapse — that window is far too short for "once per day").
   */
  private async enforceDailyCap(workspaceId: string, ruleOwnerActorId: string): Promise<void> {
    const cap = await this.entitlements.emailDailyCap(workspaceId);
    if (!Number.isFinite(cap)) return;
    const since = todayStartUtc();
    const rows = await this.db
      .select({ id: automationJobs.id })
      .from(automationJobs)
      .where(
        and(
          eq(automationJobs.workspaceId, workspaceId),
          eq(automationJobs.kind, 'send_email'),
          inArray(automationJobs.status, ['succeeded', 'running']),
          gte(automationJobs.createdAt, since),
        ),
      );
    if (rows.length <= cap) return;

    await this.notifyCapReachedOnce(workspaceId, ruleOwnerActorId, cap);
    throw new ProviderError(`daily email cap reached (${cap})`, { retryable: false });
  }

  private async notifyCapReachedOnce(workspaceId: string, actorId: string, cap: number): Promise<void> {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const already = await this.db.query.notifications.findFirst({
        where: and(
          eq(notifications.workspaceId, workspaceId),
          eq(notifications.type, 'send_email_cap_reached'),
          gte(notifications.createdAt, since),
        ),
      });
      if (already) return;
      await this.notifications.notify({
        workspaceId,
        actorId,
        type: 'send_email_cap_reached',
        recipients: [actorId],
        snippet: `Daily email cap reached (${cap}) — further send_email actions will fail until tomorrow.`,
        allowSelf: true,
      });
    } catch (error) {
      this.logger.warn(`send_email cap notification failed: ${String(error)}`);
    }
  }

  /**
   * From-address enforcement lives here (not just at connect time): the
   * connection could since have been edited outside this action's own
   * validate() check, so this is the actual "never send from a domain this
   * credential doesn't own" boundary, not connect-time validation alone.
   */
  private async sendViaResend(
    auth: Partial<ResendAuth>,
    to: string[],
    cc: string[],
    action: SendEmailAction,
    html: string,
    text: string,
  ): Promise<string> {
    if (!auth.api_key) {
      throw new ProviderError('Resend connection has no api_key', { retryable: false });
    }
    if (!auth.from_address) {
      throw new ProviderError(
        'Resend connection has no configured from_address — reconnect it with one before using send_email',
        { retryable: false },
      );
    }
    const body: Record<string, unknown> = {
      from: auth.from_address,
      to,
      subject: action.subject,
      html,
      text,
    };
    if (cc.length > 0) body.cc = cc;
    if (action.reply_to) body.reply_to = action.reply_to;

    const res = await this.connections.fetcher(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.api_key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) {
      const detail = await res.text().catch(() => '');
      throw new ProviderError(`Resend send failed: HTTP ${res.status} — ${detail}`, {
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    const json = (await res.json()) as { id?: string };
    return json.id ?? 'unknown';
  }

  private async sendViaSmtp(
    auth: Partial<SmtpConnectionAuth>,
    to: string[],
    cc: string[],
    action: SendEmailAction,
    html: string,
    text: string,
  ): Promise<string> {
    if (!auth.host || !auth.port) {
      throw new ProviderError('SMTP connection is missing host/port', { retryable: false });
    }
    if (!auth.from_address) {
      throw new ProviderError('SMTP connection has no configured from_address', { retryable: false });
    }
    const transporter = this.buildTransport({
      host: auth.host,
      port: auth.port,
      user: auth.user,
      pass: auth.pass,
    });
    try {
      const info = await transporter.sendMail({
        from: auth.from_address,
        to: to.join(', '),
        cc: cc.length > 0 ? cc.join(', ') : undefined,
        replyTo: action.reply_to,
        subject: action.subject,
        html,
        text,
      });
      return info.messageId ?? 'unknown';
    } catch (error) {
      // SMTP failures are network/auth blips as often as not — retryable
      // unless nodemailer itself says otherwise (it doesn't distinguish
      // cleanly), so this errs toward retrying rather than dropping mail.
      throw new ProviderError(
        `SMTP send failed: ${error instanceof Error ? error.message : String(error)}`,
        { retryable: true },
      );
    } finally {
      transporter.close();
    }
  }
}
