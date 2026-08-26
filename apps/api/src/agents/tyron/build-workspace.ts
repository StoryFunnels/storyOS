/**
 * Build a workspace from a sentence (#363).
 *
 * The reason the epic exists: everything else is a good assistant, this is the
 * thing that answers "why should I use a database at all" by handing someone
 * theirs.
 *
 * **No new loop.** This is `runTurn` with a different system prompt and a
 * different ceiling. A build is the same shape as any other multi-step job — read
 * the schema, create things, report — and giving it its own executor would mean
 * two loops to keep in step on ceilings, safety and attribution.
 *
 * **Not seeded from a Business Pack, and that is a decision.** #363 says it *may*
 * seed from one, and a pack apply is fast and deterministic. Rejected for v1 for
 * two reasons: choosing a pack from a sentence is its own classification problem
 * that can be confidently wrong, and a pack lands a FIXED shape that the
 * follow-up conversation then has to argue with. Building directly means what
 * arrives already matches what the person said, which is the thing being sold.
 * Worth revisiting if the cheap model proves too weak to produce a coherent
 * schema — the pack is the fallback, not the starting point.
 */

/**
 * The build's own ceiling.
 *
 * Four databases with a handful of fields each, two relations and a couple of
 * views is comfortably 25–35 tool calls — close enough to the ordinary 40 that a
 * slightly ambitious build would hit the loop guard and stop half-built, which is
 * the one outcome #363 explicitly forbids ("a failure part-way leaves a coherent
 * workspace"). Raised for this path only, and still bounded: a runaway is still
 * caught, just later.
 */
export const BUILD_MAX_TOOL_CALLS = 120;
export const BUILD_MAX_TURNS = 24;

/**
 * What Tyron is told when building.
 *
 * Deliberately prescriptive about SHAPE rather than content. The failure mode
 * this guards against is a set of disconnected tables — #363's first acceptance
 * criterion is "real databases with relations and views, not a set of
 * disconnected tables", because tables alone are a spreadsheet and relations are
 * the entire argument for StoryOS.
 *
 * It also forbids asking clarifying questions. A build is the first thing a new
 * signup does; a model that responds to "I run a design studio" with three
 * questions has already lost the moment this feature exists to win. Guessing and
 * letting them reshape it is the better trade, and reshaping is cheap because the
 * conversation continues.
 */
export const BUILD_SYSTEM_PROMPT = [
  'You are Tyron, setting up a brand-new StoryOS workspace for someone who has just described their work.',
  '',
  'Build them a REAL, CONNECTED workspace:',
  '- Create 3 to 5 databases that match what they actually do. Fewer, well-chosen ones beat a long list.',
  '- Give each database the fields that make it useful — a status or stage field where work moves through steps, dates where things are due, a number where money or effort is tracked.',
  '- CONNECT them with relations. This is the most important part: a workspace of unconnected tables is just spreadsheets. Clients relate to Projects, Projects to Tasks, and so on.',
  '- Add a board or calendar view where one genuinely helps — a status field earns a board, a date field earns a calendar.',
  '',
  'Do NOT ask clarifying questions. Make sensible choices and build. They can correct anything afterwards by asking, and they will.',
  'Do NOT create example or placeholder records. An empty database they understand beats one full of invented data they have to delete.',
  '',
  'Inspect a database before adding fields to it, so you never guess at what is already there.',
  '',
  'When you have finished, say in two or three sentences WHAT YOU BUILT and how the pieces connect — in their words, not ours. Never mention tool names, field ids, or the steps you took.',
].join('\n');
