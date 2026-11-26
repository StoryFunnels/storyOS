import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from './instrumentation';

describe('ticket #1343 the boot-time CSP_MODE warning', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('warns once about an unrecognised CSP_MODE', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('CSP_MODE', 'Report-Only');
    register();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('is not recognised');
  });

  it('is silent for empty and for the exact value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const v of ['', 'report-only']) {
      vi.stubEnv('CSP_MODE', v);
      register();
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
