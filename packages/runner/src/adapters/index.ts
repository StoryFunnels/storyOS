// SPDX-License-Identifier: Apache-2.0
import { StubAdapter } from './stub.js';
import type { RunnerAdapter } from './types.js';

/**
 * Which adapter serves which chosen tool. In this version only the stub exists, and only when it is asked for by name
 * (`--adapter stub` or `STORYOS_RUNNER_ADAPTER=stub`): a Runner paired with a real Claude Code or Cursor choice has NO adapter yet and
 * says so instead of pretending. The Claude Code adapter is ticket #1135, Cursor is #1136.
 */
export function resolveAdapter(chosenTool: string | null, override: string | undefined): RunnerAdapter | null {
  if (override === 'stub') return new StubAdapter();
  if (override) return null;
  void chosenTool;
  return null;
}
