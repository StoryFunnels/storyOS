/**
 * #1131 / ADR-0021 — the Runner's named constants (open question 10: "ship these as named constants and read them off #1141's
 * two weeks of data rather than defending them now"). Nothing else in `runners/` carries a bare number.
 */

/** `mn_run_…`: a Runner's own credential, never a PAT (`mn_pat_…`) and never accepted outside `/runner/v1/*`. */
export const RUNNER_TOKEN_PREFIX = 'mn_run_';

/** 6 characters, unambiguous: no 0/O, no 1/I/L. 31 symbols. */
export const PAIRING_CODE_LENGTH = 6;
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** The pairing window: a code is valid this long from the moment it is issued, and so is a pending Runner (ADR-0021 §3, ruling 16). */
export const PAIRING_WINDOW_MS = 10 * 60_000;
/** Wrong guesses one network address may make inside the window before every attempt from it is refused (even with the right code). */
export const PAIRING_MAX_FAILURES_PER_IP = 5;
/** The same, across every address: a distributed guesser is bounded too. A wrong guess matches no code, so this is the stand-in for "per code". */
export const PAIRING_MAX_FAILURES_GLOBAL = 300;
export const PAIRING_FAILURE_WINDOW_MS = 10 * 60_000;
/** How many codes one person may ask for in an hour, so "Add a Runner" cannot be used to mass-produce live guessable codes. */
export const PAIRING_CODES_PER_HOUR = 20;

/** The Runner is offline when it has not been heard from this long (and is active). */
export const RUNNER_OFFLINE_AFTER_MS = 120_000;
/** What the Runner is told to do. */
export const RUNNER_HEARTBEAT_INTERVAL_SECONDS = 30;
/** `last_seen_at` is written at most this often per Runner (the way `api_tokens.last_used_at` is throttled), unless something changed. */
export const RUNNER_SEEN_WRITE_THROTTLE_MS = 30_000;

/** The protocol range this server speaks. A Runner below MIN gets 426; above MAX, 409 (ADR-0021 §8). */
export const RUNNER_PROTOCOL_MIN = 1;
export const RUNNER_PROTOCOL_MAX = 1;
/** The one command that fixes `runner_upgrade_required`. */
export const RUNNER_UPGRADE_COMMAND = 'npx @storyos/runner@latest';

/** How often the sweeper runs. It must be well inside RUNNER_OFFLINE_AFTER_MS so "offline" is noticed promptly. */
export const RUNNER_SWEEP_INTERVAL_MS = 30_000;
