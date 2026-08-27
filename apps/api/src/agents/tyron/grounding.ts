/**
 * Never guess numbers — always count (#401).
 *
 * On production, asked "how many companies do we have", Tyron answered "There
 * are currently 50 companies listed in the database." It made that up. Zero tool
 * calls on the turn: it answered from nothing, in the confident register of a
 * fact. The real figure was 148. It only corrected itself when contradicted, and
 * only queried when explicitly ordered to.
 *
 * That is the worst failure mode available here, because it is invisible by
 * construction — the output is well-formed and confident, and a user who does
 * not already know the answer has no signal that anything is wrong.
 *
 * THE GUARD WAS ALREADY WRITTEN, AND IT WAS A PROMPT. `TYRON_SYSTEM_PROMPT` says
 * "an approximate count presented as a fact is worse than no answer". The model
 * ignored it. The turn loop's own comment predicted exactly this: "Every line
 * here is a rule the model can ignore, so anything that MUST hold is enforced in
 * code instead." Grounding was left in the prompt when it belonged in the loop.
 *
 * The load-bearing fact is cheap and certain: **if a turn made ZERO tool calls,
 * Tyron did not consult the workspace.** Anything it then asserts about workspace
 * contents is not merely probably wrong — it is unverifiable by construction. So
 * the loop can catch this without classifying intent, and without a model call.
 *
 * ## Why this errs toward letting things through
 *
 * A guard that trips on every number would push Tyron into hedging everything,
 * which is its own damage — #358's lesson is that the half keeping it usable
 * matters as much as the half keeping it safe. "I can help with 2 things" is not
 * a data claim and must pass untouched.
 *
 * So a sentence is only a data-quantity claim when it carries BOTH a quantity
 * AND a reference to workspace data. One without the other is left alone.
 */

/** Digits, and the number words a model actually writes in prose. */
const NUMBER_WORDS = [
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty',
  'seventy', 'eighty', 'ninety', 'hundred', 'thousand',
];

/**
 * Vague quantifiers count too.
 *
 * "There are several companies" is the same defect in a quieter voice, and the
 * ACs say so outright: a hedge is not a fix. The rule forbids the guess, not the
 * confidence.
 */
const VAGUE_QUANTIFIERS = ['several', 'a few', 'dozens', 'hundreds', 'thousands', 'many', 'a couple', 'numerous'];

/**
 * Nouns that ARE workspace storage. A quantity beside one of these is a count of
 * the user's data, full stop.
 */
const STRONG_DATA_CUES = [
  'record', 'records', 'row', 'rows', 'entry', 'entries', 'item', 'items',
  'database', 'databases', 'workspace', 'workspaces', 'table', 'tables',
  'view', 'views', 'field', 'fields', 'space', 'spaces', 'listed', 'total',
];

/**
 * Phrasings that USUALLY introduce a count but sometimes introduce anything.
 *
 * "There are 50 companies" is a data claim; "There are 3 ways to do this" is not,
 * and the difference is the noun — which cannot be enumerated, because the noun
 * is whatever the customer named their database. So a weak cue fires by DEFAULT
 * and is held back only by the blocklist below.
 *
 * Defaulting to firing is the right bias here: the founder's rule is absolute
 * ("never guess numbers — always count"), the cost of firing wrongly is one
 * wasted model round trip, and the cost of not firing is a fabricated number in
 * someone's board deck.
 */
const WEAK_DATA_CUES = ['there are', 'there is', 'there were', 'you have', 'we have', 'i found', 'i see'];

/**
 * Plural nouns that are never the user's data.
 *
 * This is a BLOCKLIST rather than an allowlist, deliberately. An allowlist of
 * data nouns would have to contain every database name every customer will ever
 * choose — "companies", in the incident that produced this ticket — so it would
 * silently fail open on exactly the sentences that matter.
 */
const NON_DATA_NOUNS = [
  'thing', 'things', 'way', 'ways', 'option', 'options', 'step', 'steps',
  'suggestion', 'suggestions', 'idea', 'ideas', 'example', 'examples',
  'reason', 'reasons', 'point', 'points', 'question', 'questions',
  'minute', 'minutes', 'second', 'seconds', 'hour', 'hours', 'day', 'days',
];

/**
 * Phrasing that makes a number a CAPABILITY or a LIMIT, not a claim about data.
 *
 * "I can create up to 100 records at a time" carries a quantity and the word
 * "records" and counts nothing. Without this the guard would nudge a correct,
 * useful sentence — and a Tyron that hedges its own documentation is the
 * over-firing failure the ACs warn about.
 */
const CAPABILITY_CUES = ['can ', 'could ', 'up to', 'maximum', 'max ', 'at most', 'limit', 'per ', 'would you', 'do you want'];

/** Instructions, where a number is a step label rather than a count. */
const INSTRUCTION_CUES = ['step ', 'click', 'open the', 'go to', 'select ', 'choose '];

/**
 * Saying you do NOT know is the behaviour this ticket wants. It must never be
 * mistaken for the fabrication it is the opposite of.
 */
const UNCERTAINTY_CUES = ["don't know", 'do not know', 'cannot', "can't", 'not sure', 'without', 'unable', 'no idea'];

/** Split on sentence boundaries, keeping it dumb — a wrong split costs a nudge, not a wrong answer. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hasQuantity(lower: string): boolean {
  if (/\d/.test(lower)) return true;
  if (VAGUE_QUANTIFIERS.some((q) => lower.includes(q))) return true;
  return NUMBER_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
}

const hasWord = (lower: string, w: string) =>
  w.includes(' ') ? lower.includes(w) : new RegExp(`\\b${w}\\b`).test(lower);

function hasDataCue(lower: string): boolean {
  if (STRONG_DATA_CUES.some((c) => hasWord(lower, c))) return true;
  // A weak cue counts unless the sentence names something that is plainly not data.
  if (WEAK_DATA_CUES.some((c) => lower.includes(c))) {
    return !NON_DATA_NOUNS.some((n) => hasWord(lower, n));
  }
  return false;
}

/**
 * Does this answer assert a quantity about the user's data?
 *
 * Only meaningful for a turn that called no tools — the caller checks that, and
 * a grounded answer is never second-guessed.
 */
export function assertsWorkspaceQuantity(text: string): boolean {
  return sentences(text).some((sentence) => {
    const lower = sentence.toLowerCase();
    if (!hasQuantity(lower)) return false;
    if (!hasDataCue(lower)) return false;
    // A question is not a claim. "Which database should I count — you have
    // several?" is the behaviour we WANT, and must not be nudged.
    if (sentence.trimEnd().endsWith('?')) return false;
    if (CAPABILITY_CUES.some((c) => lower.includes(c))) return false;
    if (INSTRUCTION_CUES.some((c) => lower.includes(c))) return false;
    if (UNCERTAINTY_CUES.some((c) => lower.includes(c))) return false;
    return true;
  });
}

/**
 * What the model is told when it answers a count without looking.
 *
 * A nudge rather than a refusal, on purpose: the right outcome is the REAL
 * number, and the model usually fetches it the moment it is told to — the
 * transcript shows it querying correctly as soon as it was ordered to. Refusing
 * outright would make Tyron useless for the commonest question there is.
 */
export const GROUNDING_NUDGE =
  'You answered with a quantity about the workspace without calling any tool, so that number cannot have come from the data. ' +
  'Do not estimate and do not hedge. Either call a tool to count it, or ask which database to count.';

/**
 * What the user gets if it fabricates twice.
 *
 * Shipping the second invention would be worse than shipping the first, because
 * by then the system knows.
 */
export const GROUNDING_REFUSAL =
  "I don't have a number for that — I haven't looked it up, and I won't guess. Tell me which database to count and I'll get the real figure.";
