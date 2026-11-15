/**
 * The one definition of "this account has been erased" (#1312).
 *
 * `GdprService.eraseGlobalIdentity` overwrites the `user` row with a tombstone whose email is `deleted-<id>@anonymized.invalid`. That
 * row is the durable fact an erasure leaves behind, so anything that writes a person's identity somewhere else (the Members
 * projection) asks THIS predicate rather than inventing its own idea of an erased user. Two spellings of the same state is how an
 * erasure ends up half-applied.
 */
export function anonymisedEmailFor(userId: string): string {
  return `deleted-${userId}@anonymized.invalid`;
}

/** True when the `user` row is an erasure tombstone. */
export function isErasedIdentity(userId: string, account: { email: string | null } | null | undefined): boolean {
  return account?.email === anonymisedEmailFor(userId);
}
