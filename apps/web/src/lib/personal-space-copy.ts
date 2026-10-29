/**
 * Ticket #1097 — the Personal space's privacy sentence, in ONE place.
 *
 * docs/architecture/personal-space.md §1 makes this wording an obligation ("say so at the point of use"), and calls a drift in it
 * a support incident: change it only together with that ADR, never in one component. It used to be typed out twice in
 * `personal-section.tsx` (a tooltip and a standing paragraph); #1097 moves it out of the sidebar as a paragraph, so it now
 * appears here, imported, at each point of use: the Personal page header, the create dialog for a personal view, and the
 * Personal row's tooltip. `personal-space-copy.unit.test.ts` pins the exact string, and that every one of those places uses it.
 */
export const PERSONAL_PRIVACY_SENTENCE = 'Only you can see this. If your account is removed, this content is deleted with it.';
