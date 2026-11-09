import { describe, expect, it } from 'vitest';
import { markdownToHtml, SendEmailActionService } from './send-email.action';

/**
 * MN-256 — the dependency-free markdown-lite renderer's own snapshot-style
 * coverage. The full send/gate/cap/webhook behavior is covered end to end
 * against a real Postgres in test/send-email-automation.test.ts (mirrors
 * job-runner.service.test.ts + test/automation-jobs.test.ts's own split).
 */
describe('markdownToHtml (MN-256)', () => {
  it('wraps a single paragraph', () => {
    expect(markdownToHtml('Hello there')).toBe('<p style="margin: 0 0 12px;">Hello there</p>');
  });

  it('splits on a blank line into separate paragraphs', () => {
    const html = markdownToHtml('First paragraph.\n\nSecond paragraph.');
    expect(html).toBe(
      '<p style="margin: 0 0 12px;">First paragraph.</p>\n<p style="margin: 0 0 12px;">Second paragraph.</p>',
    );
  });

  it('renders bold, italic, inline code, and a link', () => {
    const html = markdownToHtml('**bold** and *italic* and `code` and [a link](https://example.com)');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.com">a link</a>');
  });

  it('HTML-escapes the source before applying markdown — a rendered {Field} value cannot inject markup', () => {
    const html = markdownToHtml('Ticket <script>alert(1)</script> is done');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('a single newline within one block becomes <br>, not a new paragraph', () => {
    const html = markdownToHtml('Line one\nLine two');
    expect(html).toBe('<p style="margin: 0 0 12px;">Line one<br>Line two</p>');
  });
});

/**
 * #1044 — the SMTP SEND path holds a stored connection to the same host/port rule as the connection check, so a connection saved
 * before the rule (or a name re-pointed since) cannot reach an internal address, and a failure never echoes the library's error.
 */
describe('send via SMTP (#1044)', () => {
  type SendFn = (auth: Record<string, unknown>, to: string[], cc: string[], action: Record<string, unknown>, html: string, text: string) => Promise<string>;
  function service(sendMail: () => Promise<{ messageId?: string }>) {
    const built: Array<Record<string, unknown>> = [];
    const svc = Object.create(SendEmailActionService.prototype) as SendEmailActionService;
    svc.buildTransport = ((opts: Record<string, unknown>) => {
      built.push(opts);
      return { sendMail, close: () => undefined };
    }) as unknown as SendEmailActionService['buildTransport'];
    const send = (svc as unknown as { sendViaSmtp: SendFn }).sendViaSmtp.bind(svc);
    return { send: (auth: Record<string, unknown>) => send(auth, ['x@y.z'], [], { subject: 's' }, '<p>h</p>', 'h'), built };
  }

  it('refuses a private host or a non-SMTP port without connecting, and does not retry', async () => {
    const { send, built } = service(async () => ({ messageId: 'm' }));
    for (const auth of [{ host: '10.0.0.5', port: 587 }, { host: '8.8.8.8', port: 6379 }]) {
      const err = (await send({ ...auth, from_address: 'a@b.c' }).then(
        () => null,
        (e: unknown) => e,
      )) as { message: string; retryable?: boolean };
      expect(err.message).toMatch(/^SMTP send refused: /);
      expect(err.retryable).toBe(false);
    }
    expect(built).toHaveLength(0);
  });

  it('a send failure says one generic sentence, never the server banner', async () => {
    const { send } = service(async () => {
      throw new Error('Invalid greeting from server: "220 internal-banner ESMTP"');
    });
    await expect(send({ host: '8.8.8.8', port: 587, from_address: 'a@b.c' })).rejects.toThrow(
      'SMTP send failed: could not connect to the mail server with these settings',
    );
  });
});
