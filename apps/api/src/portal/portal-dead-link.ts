import { NotFoundException } from '@nestjs/common';

/**
 * Ticket #536 — every way a portal recipient link can be dead answers with this ONE response: revoked, expired, rotated-away,
 * tampered, malformed, unknown, or a real link presented to a portal of another workspace. Same status, same body, so the
 * response is not an oracle: a caller holding a stale or guessed link cannot learn which of those it was, nor that a recipient
 * with that id ever existed. It is a 404 rather than the 403 it used to be because a 403 says "something is here and you may
 * not see it".
 *
 * A request with NO recipient token at all is a different case and keeps its own 403 ('recipient required'): it is not a dead
 * link, and it already told the caller the view is a portal by being the view the caller asked for.
 *
 * `portal-recipients.test.ts` pins the uniformity (status, body and headers apart from the request id); one exception thrown from
 * anywhere else with different text would fail it.
 */
export const PORTAL_DEAD_LINK_MESSAGE = 'Not found';

export function portalDeadLink(): NotFoundException {
  return new NotFoundException(PORTAL_DEAD_LINK_MESSAGE);
}
