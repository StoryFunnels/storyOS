/**
 * Ticket #1227 (after #1215) — what a GUEST is told about a Runner, in ONE place.
 *
 * A Runner is a colleague's own computer and subscription. Which machine it is and which tool it runs are for the people who work
 * with it; a guest is told THAT a Runner served the work ("a Runner"), never an id, a machine name or a tool. The web already hides
 * it from a guest (`canSeeRunnerDetails`: member and admin only); this is the same rule in the API, so a client that is not the web
 * (REST, MCP, an export) cannot read what the web hides.
 *
 * Every surface that carries a Runner's identity goes through the functions below, so the rule is not re-cased per surface (the
 * defect field-surfaces.md records four times):
 *   - the wake list and run state (`maskRunState`, ticket #1215),
 *   - the Run record's own fields and the Steps line that names them (`maskRunValues`),
 *   - the field history of those fields (`RUNNER_IDENTITY_RUN_FIELDS`, used to drop them from changes, versions and activity),
 *   - the Runner stamp on what a run wrote elsewhere: a comment, a record version (`maskRunnerStamp`).
 *
 * Identity of the Runs database is the `is_system` flag plus system key `agent_runs`, never its name (ADR-0017).
 */
import type { Membership } from '../workspaces/workspace-access.guard';

export const MASKED_RUNNER_NAME = 'a Runner';

/**
 * The Agent runs fields (api names) that identify the Runner a run was on. `tool_version` names the tool as `tool` does.
 * Not in this list on purpose: `exit`, `tokens_in`, `tokens_out`, `summary`, `session_id`, `limit_resumes_at` and `wake_reason`,
 * which say what happened, not which computer it happened on.
 */
export const RUNNER_IDENTITY_RUN_FIELDS: readonly string[] = ['runner', 'tool', 'tool_version'];

/** The Runner's identity is for everyone who works with the Runner: every role but a guest (which includes a credential bound by one). */
export function seesRunnerIdentity(membership: Pick<Membership, 'role'> | undefined): boolean {
  return !membership || membership.role !== 'guest';
}

/**
 * The values of one Run record as a guest reads them. `runner` reads "a Runner" (so a Run that WAS served by a Runner still reads
 * differently from one that has none, as "Waiting to start" does in the wake list); `tool` and `tool_version` are absent; the Steps
 * log line an attempt leaves ("OK on <machine> with <tool>; ...") says "a Runner" and "the tool". Returns a new object.
 */
export function maskRunValues(values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  const machine = typeof values['runner'] === 'string' && values['runner'] !== '' ? (values['runner'] as string) : null;
  const tool = typeof values['tool'] === 'string' && values['tool'] !== '' ? (values['tool'] as string) : null;
  if (out['runner'] !== undefined && out['runner'] !== null && out['runner'] !== '') out['runner'] = MASKED_RUNNER_NAME;
  delete out['tool'];
  delete out['tool_version'];
  if (out['steps'] !== undefined) out['steps'] = redactRunnerInText(out['steps'], machine, tool);
  return out;
}

/** The attempt line `attemptLine` (run-record.ts) writes: `<Exit> on <machine> with <tool> <version>; tokens …`. */
const ATTEMPT_LINE = /\b(OK|Error|Limit reached|Aborted|Timeout) on .+? with .+?; (tokens in |tokens not reported)/g;

/** A string, or every string inside a block tree / diff entry, with the Runner's machine name and tool taken out. Returns a copy; never mutates. */
export function redactRunnerInText(value: unknown, machine: string | null, tool: string | null): unknown {
  if (typeof value === 'string') {
    let s = value.replace(ATTEMPT_LINE, `$1 on ${MASKED_RUNNER_NAME} with the tool; $2`);
    if (machine) s = s.split(machine).join(MASKED_RUNNER_NAME);
    if (tool) s = s.split(tool).join('the tool');
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => redactRunnerInText(v, machine, tool));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactRunnerInText(v, machine, tool);
    return out;
  }
  return value;
}

/**
 * The Runner stamp (`runner_id`, `runner_name`) on a comment or a record version, as a guest reads it: the name says "a Runner" and
 * the id is null, exactly the shape the wake list gives. A row with no stamp (a person's comment, anything before ticket #1132)
 * keeps null, so the mask never invents a Runner. The agent and the run stay: they are not the machine.
 */
export function maskRunnerStamp<T extends { runner_id: string | null; runner_name: string | null }>(row: T, membership: Pick<Membership, 'role'> | undefined): T {
  if (seesRunnerIdentity(membership)) return row;
  return { ...row, runner_id: null, runner_name: row.runner_name !== null || row.runner_id !== null ? MASKED_RUNNER_NAME : null };
}
