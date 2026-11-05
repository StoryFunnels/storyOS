/**
 * Ticket #1186 (and #900's rule) — the sentences on Settings › Members that used to live only in a `title=` tooltip, said in text a
 * person can read without hovering. A phone has no hover, a keyboard user never triggers one, and the reading that sends someone to
 * support is the one where they did not think to hover.
 *
 * Each sentence states what the API does TODAY (`GdprService.anonymize`, `.export`; `MembersService.remove`), not what the prototype's
 * first draft guessed: the prototype said Erase "anonymises their name on everything they wrote", but the endpoint keeps authored
 * content under the person's id, so threads and history stay intact (gdpr.service.ts `anonymize`). The shipped dialog and these lines
 * must agree, and `members-copy.unit.test.ts` pins that.
 */
export const ROLE_DESCRIPTIONS = {
  admin: 'Everything, including settings and who has access',
  member: 'Works in every space; no workspace settings',
  guest: 'Only what they are given',
} as const;

export const MEMBERS_COPY = {
  removeTitle: 'Remove from workspace',
  /** Was the Remove button's tooltip: "revoke their access ... re-invite them later". */
  removeDescription: 'Their records and comments stay. You can invite them again.',

  dataRequestsTitle: 'Data requests',
  dataRequestsSummary: 'export or erase one person’s data (GDPR)',

  exportTitle: 'Export a person’s data',
  /** Was the Export button's tooltip: "Export everything held about this member (GDPR)". */
  exportDescription: 'Everything held about them in this workspace, as a file you can send them.',

  eraseTitle: 'Erase a person from this workspace',
  /** Was the Erase button's tooltip: "removes this person and their data from THIS workspace only; ... Irreversible here". */
  eraseDescription:
    'Removes them, their per-person settings and the tokens they made here, from this workspace only. Their account and other workspaces are untouched, and their comments and history stay. Can’t be undone here.',

  /** Was the Copy link button's tooltip: "Copy the invite link to share directly". Shown on the row once a fresh link exists. */
  copyLinkDescription: 'A new link was sent. Copy it to share it yourself.',

  choosePerson: 'Choose person…',
  noOneToChoose: 'No one else in this workspace.',
} as const;

/** The explanations #1186 converted from hover to visible text, so the test can require each to be on the page. */
export const CONVERTED_FROM_HOVER: ReadonlyArray<{ control: string; was: string; now: string }> = [
  { control: 'Members › Export', was: 'title tooltip on the row button', now: MEMBERS_COPY.exportDescription },
  { control: 'Members › Erase', was: 'title tooltip on the row button', now: MEMBERS_COPY.eraseDescription },
  { control: 'Members › Remove', was: 'title tooltip on the row button', now: MEMBERS_COPY.removeDescription },
  { control: 'Members › Copy link', was: 'title tooltip on the button', now: MEMBERS_COPY.copyLinkDescription },
];
