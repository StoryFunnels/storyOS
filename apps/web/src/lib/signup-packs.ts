/**
 * The signup "What are you working on?" picker's ordering and copy (ticket #1150), kept out of the page so the rules are testable.
 *
 *  - ORDER: the three starter packs designed to be the first thing a person is offered lead (`FEATURED_SPACE_PACKS`, the same
 *    list the New space page uses, so the two doors cannot disagree about which packs are "ready to work"). Everything else
 *    follows in the registry's own order. A featured slug the registry lacks is skipped, never invented; nothing is dropped.
 *  - COPY: the why line is the pack manifest's own `why` (served by the registry), never a string copied into the page. A pack
 *    without one falls back to its summary, then to its name, so a card is never blank.
 */
import { FEATURED_SPACE_PACKS } from './space-start';

export interface SignupPackLike {
  slug: string;
  name: string;
  summary?: string | null;
  why?: string | null;
}

export function orderSignupPacks<T extends { slug: string }>(packs: readonly T[]): { featured: T[]; rest: T[] } {
  const featured = FEATURED_SPACE_PACKS.map((slug) => packs.find((p) => p.slug === slug)).filter(
    (p): p is T => p !== undefined,
  );
  const lead = new Set(featured.map((p) => p.slug));
  return { featured, rest: packs.filter((p) => !lead.has(p.slug)) };
}

export function signupPackLine(pack: SignupPackLike): string {
  return pack.why?.trim() || pack.summary?.trim() || pack.name;
}
