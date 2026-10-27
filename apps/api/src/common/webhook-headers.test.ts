import { describe, expect, it } from 'vitest';
import { UnprocessableEntityException } from '@nestjs/common';
import {
  HEADER_KEEP_FLAG,
  maskUrlUserinfo,
  maskUserinfoInText,
  presentActionHeaders,
  presentFieldConfig,
  restoreActionHeaders,
  restoreFieldConfig,
  stringHeadersOnly,
} from './webhook-headers';

const KEEP = { __keep: true } as const;

describe('presentActionHeaders (read side)', () => {
  it('replaces EVERY header value with a presence flag (#1068: not name-based)', () => {
    const presented = presentActionHeaders([
      {
        type: 'send_webhook',
        url: 'https://hooks.example.com/x',
        headers: { Authorization: 'Bearer sk-live-super-secret', 'Content-Type': 'application/json' },
      },
    ]);
    expect(presented).toEqual([
      {
        type: 'send_webhook',
        url: 'https://hooks.example.com/x',
        headers: { Authorization: { __keep: true }, 'Content-Type': { __keep: true } },
      },
    ]);
  });

  it('#1068: hides a credential in a header whose name does not look secret', () => {
    const presented = presentActionHeaders([
      { type: 'http_request', method: 'GET', url: 'https://api.example.com', headers: { 'X-Custom': 'hunter2-secret' } },
    ]);
    expect(JSON.stringify(presented)).not.toContain('hunter2-secret');
  });

  it('#1068: masks URL userinfo, keeps the rest of the URL (templates included)', () => {
    const presented = presentActionHeaders([
      { type: 'send_webhook', url: 'https://user:p4ss@hooks.example.com/x' },
      { type: 'http_request', method: 'GET', url: 'https://bob:s3cret@api.example.com/{payload.id}' },
    ]) as Array<{ url: string }>;
    expect(presented.map((a) => a.url)).toEqual([
      'https://***@hooks.example.com/x',
      'https://***@api.example.com/{payload.id}',
    ]);
    expect(JSON.stringify(presented)).not.toMatch(/p4ss|s3cret/);
  });

  it('never emits the raw secret value for any secret header', () => {
    const presented = presentActionHeaders([
      {
        type: 'send_webhook',
        url: 'https://h',
        headers: { Authorization: 'Bearer t', Cookie: 'sid=abc', 'X-Api-Key': 'k' },
      },
    ]);
    const serialized = JSON.stringify(presented);
    expect(serialized).not.toContain('Bearer t');
    expect(serialized).not.toContain('sid=abc');
    expect(serialized).not.toContain('"k"');
  });

  it('leaves non-webhook actions untouched', () => {
    const actions = [{ type: 'add_comment', body_template: 'hi' }];
    expect(presentActionHeaders(actions)).toEqual(actions);
  });
});

describe('restoreActionHeaders (write side)', () => {
  const stored = [
    {
      type: 'send_webhook',
      url: 'https://hooks.example.com/x',
      headers: { Authorization: 'Bearer sk-live-super-secret', 'Content-Type': 'application/json' },
    },
  ];

  it('preserves the stored secret when the presence flag is echoed back', () => {
    // What the client sends after loading (presented) and editing an unrelated part.
    const incoming = [
      {
        type: 'send_webhook',
        url: 'https://hooks.example.com/y', // same host, path changed
        headers: { Authorization: { __keep: true }, 'Content-Type': { __keep: true } },
      },
    ];
    const restored = restoreActionHeaders(incoming, stored) as Array<Record<string, unknown>>;
    expect(restored[0]!.headers).toEqual({
      Authorization: 'Bearer sk-live-super-secret',
      'Content-Type': 'application/json',
    });
    expect(restored[0]!.url).toBe('https://hooks.example.com/y');
  });

  it('#1068: refuses to keep a secret once the URL points at another host', () => {
    const incoming = [
      { type: 'send_webhook', url: 'https://attacker.example.net/x', headers: { Authorization: { __keep: true } } },
    ];
    expect(() => restoreActionHeaders(incoming, stored)).toThrow(/re-enter header "Authorization"/);
  });

  it('#1068: other host + http_request type swap still cannot borrow the secret', () => {
    const incoming = [
      {
        type: 'http_request',
        method: 'POST',
        url: 'https://attacker.example.net/x',
        headers: { Authorization: { __keep: true } },
      },
    ];
    expect(() => restoreActionHeaders(incoming, stored)).toThrow(UnprocessableEntityException);
  });

  it('#1068: a re-entered value on the new host is accepted', () => {
    const incoming = [
      { type: 'send_webhook', url: 'https://other.example.net/x', headers: { Authorization: 'Bearer new-host' } },
    ];
    const restored = restoreActionHeaders(incoming, stored) as Array<Record<string, unknown>>;
    expect(restored[0]!.headers).toEqual({ Authorization: 'Bearer new-host' });
  });

  it('#1068: a flag is matched by header NAME — a renamed header cannot take the old value', () => {
    const incoming = [
      { type: 'send_webhook', url: 'https://hooks.example.com/x', headers: { 'X-Leak': { __keep: true } } },
    ];
    expect(() => restoreActionHeaders(incoming, stored)).toThrow(/re-enter header "X-Leak"/);
  });

  it('#1068: a backslash/userinfo trick does not pass for the stored host', () => {
    for (const url of ['https://attacker.net\\@hooks.example.com/x', 'https://hooks.example.com@attacker.net/x']) {
      const incoming = [{ type: 'send_webhook', url, headers: { Authorization: { __keep: true } } }];
      expect(() => restoreActionHeaders(incoming, stored), url).toThrow(UnprocessableEntityException);
    }
  });

  it('replaces the stored secret when a real new string arrives', () => {
    const incoming = [
      { type: 'send_webhook', url: 'https://hooks.example.com/x', headers: { Authorization: 'Bearer NEW' } },
    ];
    const restored = restoreActionHeaders(incoming, stored) as Array<Record<string, unknown>>;
    expect(restored[0]!.headers).toEqual({ Authorization: 'Bearer NEW' });
  });

  it('drops a header omitted by the client', () => {
    const incoming = [
      { type: 'send_webhook', url: 'https://hooks.example.com/x', headers: { 'Content-Type': 'application/json' } },
    ];
    const restored = restoreActionHeaders(incoming, stored) as Array<Record<string, unknown>>;
    expect(restored[0]!.headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('drops a keep-flag with no stored counterpart instead of fabricating one', () => {
    const incoming = [
      { type: 'send_webhook', url: 'https://new', headers: { Authorization: { __keep: true } } },
    ];
    const restored = restoreActionHeaders(incoming, []) as Array<Record<string, unknown>>;
    expect(restored[0]!.headers).toEqual({});
  });

  it('recovers the stored value by destination when a sibling action shifts the index', () => {
    const incoming = [
      { type: 'add_comment', body_template: 'inserted first' },
      {
        type: 'send_webhook',
        url: 'https://hooks.example.com/x',
        headers: { Authorization: { __keep: true } },
      },
    ];
    const restored = restoreActionHeaders(incoming, stored) as Array<Record<string, unknown>>;
    expect(restored[1]!.headers).toEqual({ Authorization: 'Bearer sk-live-super-secret' });
  });

  it('round-trips: present then restore is identity for the stored secret', () => {
    const presented = presentActionHeaders(stored);
    const restored = restoreActionHeaders(presented, stored);
    expect(restored).toEqual(stored);
  });

  it('#1068: keeps each secret with its own action when two same-host actions swap places', () => {
    const two = [
      { type: 'send_webhook', url: 'https://hooks.example.com/a', headers: { Authorization: 'A' } },
      { type: 'send_webhook', url: 'https://hooks.example.com/b', headers: { Authorization: 'B' } },
    ];
    const swapped = (presentActionHeaders(two) as unknown[]).reverse();
    const restored = restoreActionHeaders(swapped, two) as Array<{ url: string; headers: Record<string, string> }>;
    expect(restored.map((a) => [a.url, a.headers.Authorization])).toEqual([
      ['https://hooks.example.com/b', 'B'],
      ['https://hooks.example.com/a', 'A'],
    ]);
  });
});

describe('#1068 URL userinfo round-trip', () => {
  const stored = [{ type: 'http_request', method: 'GET', url: 'https://bob:s3cret@api.example.com/{payload.id}' }];

  it('the mask echoed back on the same host restores the stored userinfo', () => {
    const presented = presentActionHeaders(stored);
    expect(restoreActionHeaders(presented, stored)).toEqual(stored);
  });

  it('the mask on another host is refused on update', () => {
    const incoming = [{ type: 'http_request', method: 'GET', url: 'https://***@attacker.net/' }];
    expect(() => restoreActionHeaders(incoming, stored)).toThrow(/re-enter the URL credentials/);
  });

  it('removing the userinfo removes it; a new one replaces it', () => {
    const cleared = restoreActionHeaders([{ ...stored[0], url: 'https://api.example.com/{payload.id}' }], stored);
    expect((cleared as Array<{ url: string }>)[0]!.url).toBe('https://api.example.com/{payload.id}');
    const replaced = restoreActionHeaders([{ ...stored[0], url: 'https://amy:n3w@api.example.com/' }], stored);
    expect((replaced as Array<{ url: string }>)[0]!.url).toBe('https://amy:n3w@api.example.com/');
  });

  it('on create (nothing stored) a stray mask is dropped, never fabricated', () => {
    const created = restoreActionHeaders([{ ...stored[0], url: 'https://***@api.example.com/' }], []);
    expect((created as Array<{ url: string }>)[0]!.url).toBe('https://api.example.com/');
  });

  it('masks the userinfo shapes the URL parser also reads as credentials', () => {
    expect(maskUrlUserinfo('https:bob:pw@api.example.com/x')).toBe('https:***@api.example.com/x');
    expect(maskUrlUserinfo('ht\ttps://bob:pw@api.example.com/')).toBe('https://***@api.example.com/');
    expect(maskUrlUserinfo('https://api.example.com/users/@me')).toBe('https://api.example.com/users/@me');
    expect(maskUrlUserinfo('{payload.url}')).toBe('{payload.url}');
  });

  it('maskUserinfoInText masks a URL inside an approval preview line', () => {
    expect(maskUserinfoInText('POST https://bob:pw@api.example.com/x')).toBe('POST https://***@api.example.com/x');
    expect(maskUserinfoInText('Webhook → https://hooks.example.com/x')).toBe('Webhook → https://hooks.example.com/x');
  });
});

describe('field config helpers (button carrier)', () => {
  const config = {
    color: 'green',
    actions: [
      { type: 'send_webhook', url: 'https://h', headers: { Authorization: 'Bearer top-secret' } },
    ],
  };

  it('presentFieldConfig hides secret header values inside a button config', () => {
    const presented = presentFieldConfig(config) as { actions: Array<{ headers: Record<string, unknown> }> };
    expect(presented.actions[0]!.headers).toEqual({ Authorization: { __keep: true } });
    expect(JSON.stringify(presented)).not.toContain('top-secret');
  });

  it('restoreFieldConfig preserves the stored secret across an unrelated edit', () => {
    const presented = presentFieldConfig(config) as Record<string, unknown>;
    const edited = { ...presented, color: 'blue' }; // unrelated field changed
    const restored = restoreFieldConfig(edited, config) as {
      color: string;
      actions: Array<{ headers: Record<string, unknown> }>;
    };
    expect(restored.color).toBe('blue');
    expect(restored.actions[0]!.headers).toEqual({ Authorization: 'Bearer top-secret' });
  });

  it('passes non-button configs through untouched', () => {
    const plain = { multiline: true };
    expect(presentFieldConfig(plain)).toEqual(plain);
    expect(restoreFieldConfig(plain, {})).toEqual(plain);
  });
});

describe('stringHeadersOnly', () => {
  it('keeps only string values (persisted actions never carry flags)', () => {
    expect(stringHeadersOnly({ A: 'x', B: { __keep: true } as never })).toEqual({ A: 'x' });
    expect(stringHeadersOnly({})).toBeUndefined();
    expect(stringHeadersOnly(undefined)).toBeUndefined();
  });
});

describe('HEADER_KEEP_FLAG', () => {
  it('is the exported sentinel shape', () => {
    expect(HEADER_KEEP_FLAG).toEqual(KEEP);
  });
});
