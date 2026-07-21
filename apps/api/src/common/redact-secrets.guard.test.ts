import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSecretKey } from './redact-secrets';

/**
 * The structural guard behind `redactSecrets` (see that file's header).
 *
 * `redactSecrets` matches secret keys by *pattern*, which covers every naming
 * shape we use today but cannot prove it covers the next one. So this test casts
 * a deliberately **wider and dumber** net over the sources that define settings /
 * config blobs — any declared property whose name contains a word like `secret`,
 * `token`, `key`, `auth`, `pat`, `private`, `session`, `cookie` — and demands that
 * each hit is either:
 *
 *   1. redacted by `isSecretKey`, or
 *   2. listed in DECLARED_SAFE below, with a reason.
 *
 * The two nets are intentionally *different*: if this test reused the production
 * pattern it would be circular and prove nothing. The wide net over-matches on
 * purpose, and the cost of over-matching is one line here.
 *
 * The property this buys: **adding a secret-shaped field to an integration config
 * and shipping it is a failing test, not a silent leak.** That is the bug class
 * that let `github.webhook_secret` reach `GET /workspaces/:ws` in plaintext — the
 * exact-name denylist simply did not know about it, and nothing complained.
 *
 * The directories are globbed, not enumerated file-by-file, so a brand new
 * integration file is swept the day it lands.
 */
/** Walk up to the workspace root, so the scan works from any cwd vitest is run in. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('workspace root not found — the redaction guard cannot scan');
}
const REPO_ROOT = repoRoot();

/** Where settings / config blobs and their zod schemas are declared. */
const SCANNED_DIRS = [
  'apps/api/src/integrations',
  'apps/api/src/webhooks',
  'apps/api/src/automations',
  'apps/api/src/agents',
  'apps/api/src/workspaces',
  'packages/schemas/src',
];

/** The wide net. Any of these words *anywhere* in a property name is a suspect. */
const SUSPECT_WORD =
  /^(secret|secrets|token|tokens|key|keys|password|passwd|passphrase|credential|credentials|auth|authorization|pat|bearer|signature|signing|private|cert|certificate|session|cookie|apikey)$/;

/**
 * Secret-*shaped* names that are deliberately not redacted. Every entry needs a
 * reason, and the test below fails if an entry stops being reachable or becomes
 * covered — a stale exemption is how a denylist rots.
 */
const DECLARED_SAFE: Record<string, string> = {
  // NB `has_token` / `has_webhook_secret` are *not* listed: `isSecretKey` matches
  // them on the `*_token` / `*_secret` tail, and it is the boolean *value* that
  // spares them at redaction time. They are covered, not exempted.
  key: "a Linear team's key (`ENG`), an identifier, not a credential",
  team_keys: 'Linear team identifiers — the non-secret sibling of api_key',
  // apps/api/src/integrations/linear-source-adapter.ts (MN-236) — the
  // migration-framework SourceAdapter's `LinearSourceConfig.teamKeys`, the same
  // non-secret Linear team identifiers as `team_keys` above, just camelCase to
  // match the new adapter's config shape. `LinearService` still owns `team_keys`
  // (snake_case, settings-blob shaped) for its own read/write path, so both
  // spellings are live at once rather than one superseding the other.
  teamKeys:
    'apps/api/src/integrations/linear-source-adapter.ts (MN-236) — camelCase sibling of team_keys, same non-secret Linear team identifiers',
  signature: 'an HMAC we compute per delivery; never stored in a settings blob',
  tokenHash: 'sha256 of an invite token — the plaintext never round-trips',
  // #201: a workspace-level boolean feature flag ("gate files behind an access
  // check"), not a credential — `private` here means "access-controlled", the
  // same sense as a private repo or a private Slack channel. `isRedactable`
  // already exempts booleans on principle (a bit is never a secret), so this
  // entry documents intent rather than covering a real gap.
  private_attachments: 'a workspace boolean flag (#201) — "private" describes access mode, not a credential',
  // NB `public_token` (a form's share token, MN-101) *is* matched by isSecretKey,
  // so it needs no exemption — but nothing redacts a view's config today, which is
  // deliberate: the admin UI reads it back to build the share link. If view config
  // ever starts flowing through redactSecrets, that link breaks and this comment is
  // the reason why.
  tokensIn:
    'apps/api/src/agents/agents.service.ts (MN-188) — a token *count* for StoryOS-AI run cost/credit metering, not a credential',
  tokensOut:
    'apps/api/src/agents/agents.service.ts (MN-188) — a token *count* for StoryOS-AI run cost/credit metering, not a credential',
  // packages/schemas/src/connections.ts (MN-252) — a discriminator string
  // ('oauth2' | 'api_key' | 'smtp'), not a credential. NB its sibling `auth` (the
  // actual raw credential payload on the same schema) is NOT exempted here — it's
  // real secret material and is covered by the `auth` tail in redact-secrets.ts
  // instead, which gives it wholesale redaction.
  auth_kind: "packages/schemas/src/connections.ts (MN-252) — the provider's auth-mechanism discriminator, not a credential",
};

function propertyNames(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const dir of SCANNED_DIRS) {
    for (const file of readdirSync(join(REPO_ROOT, dir))) {
      if (!file.endsWith('.ts') || file.includes('.test.')) continue;
      const path = join(dir, file);
      const source = readFileSync(join(REPO_ROOT, path), 'utf8');
      for (const line of source.split('\n')) {
        // A declared property: `webhook_secret?: z.string()`, `token: string`, `'x-api-key': v`.
        const match = /^\s*(?:readonly\s+)?['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\??\s*:/.exec(line);
        if (!match) continue;
        const key = match[1]!;
        const words = key
          .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
          .split(/[^a-zA-Z0-9]+|\s+/)
          .filter(Boolean)
          .map((w) => w.toLowerCase());
        if (!words.some((w) => SUSPECT_WORD.test(w))) continue;
        found.set(key, (found.get(key) ?? new Set()).add(relative('.', path)));
      }
    }
  }
  return found;
}

describe('redaction coverage guard', () => {
  const suspects = propertyNames();

  it('the scanner actually reads the sources (canary — not a vacuous sweep)', () => {
    // If these three stop being found, the scan silently matched nothing and every
    // assertion below would pass for the wrong reason.
    expect([...suspects.keys()]).toEqual(
      expect.arrayContaining(['webhook_secret', 'api_key', 'bot_token']),
    );
    expect(suspects.size).toBeGreaterThan(5);
  });

  it('every secret-shaped config key is redacted or declared safe', () => {
    const uncovered = [...suspects.entries()]
      .filter(([key]) => !isSecretKey(key) && !(key in DECLARED_SAFE))
      .map(([key, files]) => `  ${key}  (${[...files].join(', ')})`);

    expect(
      uncovered,
      uncovered.length === 0
        ? ''
        : `These config keys look like secrets but redactSecrets would serve them in plaintext:\n${uncovered.join(
            '\n',
          )}\n\nEither the name is a credential — then it needs a matching tail in redact-secrets.ts —\nor it is not, and it belongs in DECLARED_SAFE with a reason.`,
    ).toEqual([]);
  });

  it('no stale exemptions: every DECLARED_SAFE key is still reachable and still unredacted', () => {
    for (const key of Object.keys(DECLARED_SAFE)) {
      expect(suspects.has(key), `${key} is exempted but no longer exists — drop it`).toBe(true);
      expect(isSecretKey(key), `${key} is exempted but redactSecrets now covers it — drop it`).toBe(
        false,
      );
    }
  });
});
