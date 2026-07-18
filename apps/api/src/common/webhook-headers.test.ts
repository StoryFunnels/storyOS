import { describe, expect, it } from 'vitest';
import {
  HEADER_KEEP_FLAG,
  isSecretHeaderName,
  presentActionHeaders,
  presentFieldConfig,
  restoreActionHeaders,
  restoreFieldConfig,
  stringHeadersOnly,
} from './webhook-headers';

const KEEP = { __keep: true } as const;

describe('isSecretHeaderName', () => {
  it('reuses the redact-secrets key rule for token/api-key headers', () => {
    expect(isSecretHeaderName('Authorization')).toBe(true);
    expect(isSecretHeaderName('X-Api-Key')).toBe(true);
    expect(isSecretHeaderName('X-Auth-Token')).toBe(true);
    expect(isSecretHeaderName('X-Webhook-Secret')).toBe(true);
  });

  it('adds the header-only names a key shape cannot infer', () => {
    expect(isSecretHeaderName('Cookie')).toBe(true);
    expect(isSecretHeaderName('set-cookie')).toBe(true);
    expect(isSecretHeaderName('Proxy-Authorization')).toBe(true);
  });

  it('leaves ordinary headers readable', () => {
    expect(isSecretHeaderName('Content-Type')).toBe(false);
    expect(isSecretHeaderName('Accept')).toBe(false);
    expect(isSecretHeaderName('X-Request-Id')).toBe(false);
  });
});

describe('presentActionHeaders (read side)', () => {
  it('replaces secret header VALUES with a presence flag, keeps non-secret ones', () => {
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
        headers: { Authorization: { __keep: true }, 'Content-Type': 'application/json' },
      },
    ]);
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
    // What the client sends after loading (presented) and editing an unrelated field.
    const incoming = [
      {
        type: 'send_webhook',
        url: 'https://hooks.example.com/y', // url changed — unrelated edit
        headers: { Authorization: { __keep: true }, 'Content-Type': 'application/json' },
      },
    ];
    const restored = restoreActionHeaders(incoming, stored) as Array<Record<string, unknown>>;
    expect(restored[0]!.headers).toEqual({
      Authorization: 'Bearer sk-live-super-secret',
      'Content-Type': 'application/json',
    });
    expect(restored[0]!.url).toBe('https://hooks.example.com/y');
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

  it('recovers the stored value by url when a sibling action shifts the index', () => {
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
