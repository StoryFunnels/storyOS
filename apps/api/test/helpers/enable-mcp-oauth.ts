/**
 * Side-effect helper: turns MCP_OAUTH on before the app module is ever imported.
 * env() reads and caches MCP_OAUTH when AppModule is evaluated, so the value must
 * be in process.env BEFORE that import — which is why this must be the very first
 * import in any file that uses it (mirrors helpers/auth-rate-limit.ts).
 *
 * process.env is shared across files in a worker, so restoreMcpOAuth() must run
 * in afterAll to avoid leaving MCP_OAUTH on for unrelated test files.
 */
const original = process.env.MCP_OAUTH;
process.env.MCP_OAUTH = 'true';

export function restoreMcpOAuth(): void {
  if (original === undefined) delete process.env.MCP_OAUTH;
  else process.env.MCP_OAUTH = original;
}
