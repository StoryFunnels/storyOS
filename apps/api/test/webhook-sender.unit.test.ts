import { describe, expect, it, vi } from 'vitest';
import {
  MAX_ATTEMPTS,
  deliverWebhook,
  isPrivateAddress,
  isSuccess,
  nextAttemptDelayMs,
  signPayload,
  verifySignature,
} from '../src/webhooks/webhook-sender';
import { jsonEscape, parseTemplateBody } from '../src/automations/actions.service';

const SECRET = 'whsec_test';

describe('signing (MN-032)', () => {
  it('round-trips a signature', () => {
    const body = JSON.stringify({ event: 'record.created' });
    const sig = signPayload(SECRET, body, 1_700_000_000);
    expect(verifySignature(SECRET, body, 1_700_000_000, sig)).toBe(true);
    expect(verifySignature(SECRET, body, 1_700_000_000, `sha256=${sig}`)).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, and a replayed timestamp', () => {
    const body = JSON.stringify({ amount: 1 });
    const sig = signPayload(SECRET, body, 1_700_000_000);
    expect(verifySignature(SECRET, JSON.stringify({ amount: 9999 }), 1_700_000_000, sig)).toBe(false);
    expect(verifySignature('whsec_other', body, 1_700_000_000, sig)).toBe(false);
    // The timestamp is inside the signed string, so a captured payload replayed
    // under a new timestamp fails.
    expect(verifySignature(SECRET, body, 1_700_009_999, sig)).toBe(false);
  });

  it('does not throw on a length-mismatched signature', () => {
    expect(verifySignature(SECRET, 'x', 1, 'short')).toBe(false);
  });

  /**
   * The raw-bytes pin (the #42 lesson, applied here).
   *
   * A tamper test alone does NOT prove the HMAC covers the bytes it was given: a
   * verifier that canonicalised via `JSON.stringify(JSON.parse(body))` still
   * rejects a tampered body, because the tampered payload re-serialises to a
   * *different* canonical form and fails anyway. Only a body that is valid JSON
   * whose exact bytes do not survive a parse → stringify round-trip can tell the
   * two apart.
   *
   * `signPayload` takes the body as a string and never re-parses it, so this is
   * currently true by construction — this test exists to keep it that way. Both
   * halves matter: the raw bytes must verify, AND the canonical-form signature
   * must be rejected for those same bytes.
   */
  it('signs the exact bytes it is given, not a re-serialized body', () => {
    const canonical = JSON.stringify({ zen: 'raw bytes matter' });
    const raw = `{  "zen"  :  "raw bytes matter"  }`;
    expect(raw).not.toBe(canonical);
    expect(JSON.parse(raw)).toEqual(JSON.parse(canonical));

    const ts = 1_700_000_000;
    const rawSig = signPayload(SECRET, raw, ts);
    const canonicalSig = signPayload(SECRET, canonical, ts);
    // Sanity: the two forms genuinely digest differently, so the assertions below
    // are not vacuously true.
    expect(rawSig).not.toBe(canonicalSig);

    // The bytes that were signed verify…
    expect(verifySignature(SECRET, raw, ts, rawSig)).toBe(true);
    // …and a signature over the canonical form is NOT accepted for those bytes.
    // This flips to `true` the moment either function canonicalises.
    expect(verifySignature(SECRET, raw, ts, canonicalSig)).toBe(false);
  });
});

describe('backoff (MN-032)', () => {
  it('escalates 1/2/4/8 minutes then gives up', () => {
    expect(nextAttemptDelayMs(1)).toBe(60_000);
    expect(nextAttemptDelayMs(2)).toBe(120_000);
    expect(nextAttemptDelayMs(3)).toBe(240_000);
    expect(nextAttemptDelayMs(4)).toBe(480_000);
    expect(nextAttemptDelayMs(MAX_ATTEMPTS)).toBeNull();
  });

  it('treats 2xx as success and everything else as retryable', () => {
    expect(isSuccess(200)).toBe(true);
    expect(isSuccess(204)).toBe(true);
    expect(isSuccess(302)).toBe(false);
    expect(isSuccess(500)).toBe(false);
  });
});

describe('SSRF guard (MN-032)', () => {
  it('flags loopback, private, link-local and IPv6-mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255',
                      '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '11.0.0.1', '2606:4700::1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('refuses to send to a private literal, without calling fetch', async () => {
    const fetcher = vi.fn();
    const result = await deliverWebhook(fetcher, {
      url: 'https://127.0.0.1/hook',
      secret: SECRET,
      body: {},
      eventType: 'record.created',
      deliveryId: 'd1',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/private address/);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('delivery (MN-032)', () => {
  const base = {
    url: 'https://example.com/hook',
    secret: SECRET,
    body: { event: 'record.created', record: { id: 'r1' } },
    eventType: 'record.created',
    deliveryId: 'del-1',
    now: 1_700_000_000_000,
  };

  it('signs the exact bytes it sends, and reports 2xx as ok', async () => {
    let seen: { headers: Record<string, string>; body: string } | null = null;
    const fetcher = vi.fn(async (_url: string, init: never) => {
      seen = init as unknown as { headers: Record<string, string>; body: string };
      return { status: 200 };
    });

    const result = await deliverWebhook(fetcher, base);
    expect(result).toEqual({ ok: true, statusCode: 200 });

    const { headers, body } = seen!;
    const ts = Number(headers['X-StoryOS-Timestamp']);
    expect(verifySignature(SECRET, body, ts, headers['X-StoryOS-Signature']!)).toBe(true);
    expect(headers['X-StoryOS-Event']).toBe('record.created');
    expect(headers['X-StoryOS-Delivery']).toBe('del-1');
    expect(JSON.parse(body)).toEqual(base.body);
  });

  it('reports a non-2xx as a retryable failure', async () => {
    const result = await deliverWebhook(async () => ({ status: 500 }), base);
    expect(result).toEqual({ ok: false, statusCode: 500, error: 'HTTP 500' });
  });

  it('turns a network throw into a failure instead of propagating', async () => {
    const result = await deliverWebhook(async () => {
      throw new Error('ECONNREFUSED');
    }, base);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });

  it('never lets caller headers override the signature (MN-088)', async () => {
    let seen: Record<string, string> = {};
    await deliverWebhook(
      async (_url, init) => {
        seen = init.headers;
        return { status: 200 };
      },
      { ...base, headers: { 'X-StoryOS-Signature': 'sha256=forged', 'X-Custom': 'keep' } },
    );
    expect(seen['X-StoryOS-Signature']).not.toBe('sha256=forged');
    expect(seen['X-Custom']).toBe('keep');
  });
});

describe('button body_template (MN-088)', () => {
  it('parses JSON so the receiver gets an object, not a quoted string', () => {
    expect(parseTemplateBody('{"title":"Hello"}')).toEqual({ title: 'Hello' });
    expect(parseTemplateBody('  [1,2]  ')).toEqual([1, 2]);
  });

  it('wraps non-JSON and malformed JSON rather than throwing', () => {
    expect(parseTemplateBody('just text')).toEqual({ body: 'just text' });
    expect(parseTemplateBody('{"broken":')).toEqual({ body: '{"broken":' });
  });

  it('escapes a value so it cannot break out of its JSON string', () => {
    // Caught in real testing: a title with a quote used to produce invalid JSON.
    const title = 'He said "ship it"\nnow\\then';
    const body = `{"task":"${jsonEscape(title)}"}`;
    expect(parseTemplateBody(body)).toEqual({ task: title });
  });
});

/**
 * The token regex used to be /\{([^}]+)\}/g, which ran across a JSON template's
 * own braces: `{"task":"{Name}"}` matched `{"task":"{Name}` as ONE token and the
 * body was destroyed. Excluding `{` from the class is what fixes it (MN-088).
 */
describe('token matching inside a JSON body (MN-088)', () => {
  const tokens = (template: string) =>
    [...template.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!.trim());

  it('picks out only the field tokens, not the JSON braces', () => {
    expect(tokens('{"task":"{Name}","state":"{State}","fired":true}')).toEqual(['Name', 'State']);
  });

  it('still matches a bare token in plain text', () => {
    expect(tokens('Done ✅ ({Title})')).toEqual(['Title']);
  });

  it('the old pattern demonstrably swallowed the JSON', () => {
    const old = [...'{"task":"{Name}"}'.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    expect(old).toEqual(['"task":"{Name']); // the bug, pinned
  });
});
