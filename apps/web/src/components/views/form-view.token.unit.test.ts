import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1041 — the server mints a form's public token; the browser must never choose one. A token the client picks
 * is a token an attacker can register in their own workspace to capture someone else's submissions.
 */
const src = (file: string) => readFileSync(join(__dirname, file), 'utf8');

describe('the browser does not mint a form token (#1041)', () => {
  it('form-view.tsx generates no random value and sends no public_token when sharing starts', () => {
    const form = src('form-view.tsx');
    expect(form).not.toMatch(/randomUUID|getRandomValues|Math\.random/);
    // The only public_token the builder may send is "none" (Stop sharing); never a value.
    const sends = [...form.matchAll(/public_token:\s*([^,}\s]+)/g)].map((m) => m[1]);
    expect(sends.every((v) => v === 'undefined')).toBe(true);
  });

  it('the save keeps the server config, so the minted token reaches the page without a reload', () => {
    const state = src('use-view-state.ts');
    expect(state).toMatch(/sent: saved, saved: server \?\? saved/);
    expect(state).toMatch(/JSON\.stringify\(result\.sent\)/);
  });
});
