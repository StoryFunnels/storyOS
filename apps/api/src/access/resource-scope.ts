import { SetMetadata } from '@nestjs/common';

/**
 * #543 — a token bound to specific spaces/databases may call ONLY routes that carry this
 * marker. Deny by default: a route nobody has audited for a bound token is refused rather
 * than leaking until someone notices, and a new route is refused until it is marked.
 *
 * Marking a route is a claim that EVERY read it performs goes through AccessService (which
 * narrows a bound token exactly like a guest). test/resource-bound-token.test.ts walks the
 * marked set, so a mark added without that claim being true has to survive a named test.
 */
export const RESOURCE_SCOPABLE_KEY = 'storyos:resourceScopable';
/**
 * The ONE refusal a bound token gets for anything outside its boundary. Identical whether the
 * target exists or not, so the refusal cannot be used to probe for existence, and it names the
 * boundary instead of returning an empty answer an agent would report as "there is nothing".
 */
export const BOUNDARY_REFUSAL =
  'This token is bound to specific spaces or databases; that is outside the boundary it was minted for';

export const ResourceScopable = () => SetMetadata(RESOURCE_SCOPABLE_KEY, true);
