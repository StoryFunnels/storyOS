/**
 * #365 — the tool-argument schema version, advertised so a client can tell it is
 * behind.
 *
 * ## Why this exists
 *
 * An MCP client negotiates tool schemas ONCE, at connect. Deploy a server whose
 * argument shapes have changed and every already-connected client keeps sending
 * the old shape — while the new server refuses it. That happened on 2026-08-21:
 * #343 tightened argument validation, and every write from a session that had
 * connected before the deploy began failing with `expected record, received
 * string`. Reads were unaffected (they take plain strings), so it read as a data
 * problem rather than a version problem, and the natural reaction — doubt your
 * own arguments and retry variations — was exactly wrong.
 *
 * ## What already solved most of it, and what did not
 *
 * `59d9633` made the server TOLERATE the old shape (`coerceStringified`), which
 * is a better fix than a better error message: a stale client now works instead
 * of failing. That dissolved the original incident.
 *
 * Tolerance cannot absorb every future change, though. It handles a changed
 * ENCODING — the same value arriving as a JSON string. It cannot handle a removed
 * argument, or one whose MEANING changed, because there is nothing to coerce
 * toward. For those, a client has to be able to notice it is behind, and that is
 * what this constant is for.
 *
 * ## When to bump it
 *
 * Bump on any change to a tool's argument shape that a client negotiated at
 * connect: adding or removing an argument, changing a type, or changing what an
 * existing argument MEANS. Do not bump for descriptions, titles, or a new tool
 * (a client that does not know a tool simply never calls it).
 *
 * The version rides on the MCP `serverInfo.version` a client already displays,
 * and is stated by `get_started` — the tool an agent is told to call first — so
 * it is visible both before and during a session rather than only in release
 * notes nobody reads while writes are failing.
 *
 * ## 2 → 3 (#450, #508)
 *
 * #450 changed `reg()` to register `z.object(shape).catchall(z.unknown())`
 * with the SDK instead of a bare shape, so an unrecognized top-level argument
 * survives the SDK's own pre-handler parse and reaches `rejectUnknownArgs`
 * instead of being silently stripped. No individual argument's name, type or
 * meaning changed — but the ADVERTISED schema shape changed for all 139 tools
 * (catchall/`additionalProperties` semantics), and a stale-connected client's
 * call that used to silently half-succeed now gets a loud refusal instead.
 * That is exactly the class of change this constant exists to signal.
 */
export const TOOL_SCHEMA_VERSION = 3;

/** Package version, kept separate from the schema version it carries. */
const PACKAGE_VERSION = '0.1.0';

/**
 * What the client sees as `serverInfo.version`. The `+tools.N` build-metadata
 * suffix is valid semver and inert to anything that parses it, so a client that
 * only wants the package version still gets one.
 */
export const MCP_SERVER_VERSION = `${PACKAGE_VERSION}+tools.${TOOL_SCHEMA_VERSION}`;

/**
 * The line `get_started` prints, and the one to search for when writes start
 * failing after a deploy. Deliberately names the symptom ("arguments are being
 * rejected") rather than only the remedy, because the symptom is what someone
 * has in front of them at that moment.
 */
export const SCHEMA_VERSION_NOTICE =
  `Tool-argument schema version: ${TOOL_SCHEMA_VERSION} (server ${MCP_SERVER_VERSION}). ` +
  'A client negotiates tool schemas once, when it connects. If this session connected before the ' +
  'server was last deployed and your arguments are being rejected on shape, your tool definitions ' +
  'are stale — reconnect to refresh them rather than retrying different argument shapes.';
