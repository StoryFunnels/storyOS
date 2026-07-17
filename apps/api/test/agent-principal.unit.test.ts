import { describe, expect, it } from 'vitest';
import { deriveAgentPrincipal, scopeForRole } from '../src/agents/agent-principal';

/**
 * #207 / ADR-0010 §2 — least privilege is the property most worth pinning down:
 * an agent must never act with more power than its owner, whatever it declares.
 * Pure function, so no app/database here.
 */
describe('deriveAgentPrincipal (#207, ADR-0010 §2)', () => {
  it('caps the agent at its owner — owner write + agent admin → write', () => {
    expect(deriveAgentPrincipal('u1', 'write', ['admin'])).toEqual({ userId: 'u1', scope: 'write' });
  });

  it('defaults to read when the agent declares nothing', () => {
    expect(deriveAgentPrincipal('u1', 'admin', [])).toEqual({ userId: 'u1', scope: 'read' });
  });

  it('takes the agent ceiling when it is below the owner — owner admin + agent write → write', () => {
    expect(deriveAgentPrincipal('u1', 'admin', ['write'])).toEqual({ userId: 'u1', scope: 'write' });
  });

  it('uses the highest scope the agent declares, still capped by the owner', () => {
    expect(deriveAgentPrincipal('u1', 'admin', ['read', 'write']).scope).toBe('write');
    expect(deriveAgentPrincipal('u1', 'admin', ['read', 'write', 'admin']).scope).toBe('admin');
    expect(deriveAgentPrincipal('u1', 'read', ['read', 'write', 'admin']).scope).toBe('read');
  });

  it('ignores unknown scope labels rather than trusting them — a typo cannot widen scope', () => {
    expect(deriveAgentPrincipal('u1', 'admin', ['superuser']).scope).toBe('read');
    expect(deriveAgentPrincipal('u1', 'admin', ['write', 'root']).scope).toBe('write');
  });

  it('carries the owner id — the run is attributed to a real user', () => {
    expect(deriveAgentPrincipal('owner-42', 'write', ['write']).userId).toBe('owner-42');
  });
});

describe('scopeForRole (#207) — the owner ceiling for a manual run', () => {
  it('maps membership roles onto the token-scope ladder', () => {
    expect(scopeForRole('admin')).toBe('admin');
    expect(scopeForRole('member')).toBe('write');
    expect(scopeForRole('guest')).toBe('read');
  });
});
