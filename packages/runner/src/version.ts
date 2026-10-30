// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

/** The package version, read from the package's own package.json (it is always published beside `dist/`). */
export function runnerVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof v === 'string' && v) return v;
  } catch {
    // fall through
  }
  return '0.0.0';
}

/** The machine's name as the person sees it in StoryOS ("Ievgen's MacBook"). Reported, unverified. */
export function machineName(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STORYOS_RUNNER_NAME?.trim();
  const name = (override || hostname() || 'This computer').replace(/\.local$/, '');
  return name.slice(0, 120);
}

export const DEFAULT_SERVER = 'https://app.storyos.dev';

/** Where the tool reaches StoryOS's MCP server. The claim response does not carry it, so it is derived (and overridable). */
export function mcpUrlFor(server: string, override?: string): string {
  if (override) return override;
  const s = server.replace(/\/+$/, '');
  if (s === DEFAULT_SERVER) return 'https://mcp.storyos.dev/mcp';
  return `${s}/mcp`;
}
