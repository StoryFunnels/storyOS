/**
 * Ticket #1326 — the one definition of "I just made a blank record, take me to it".
 *
 * Every quick-add (board card, list group +, calendar day, gallery, feed, the empty-database button, the
 * toolbar New, the mobile FAB) creates the record with NO name: the title is empty and the record page
 * shows its "Untitled" placeholder. A literal 'Untitled' name was the bug: typing in the title saved
 * "UntitledBook the venue". `row.title || 'Untitled'` display fallbacks are unrelated and stay.
 *
 * The href carries `?new=1` so the record page puts the cursor in the title (Notion / Trello behaviour),
 * then drops the flag so a refresh or Back does not steal focus again.
 */
export const NEW_RECORD_PARAM = 'new';

export function newRecordHref(ws: string, db: string, rec: string): string {
  return `/w/${ws}/d/${db}/r/${rec}?${NEW_RECORD_PARAM}=1`;
}

/** True when a location search string asks the record page to focus its title. */
export function wantsTitleFocus(search: string): boolean {
  return new URLSearchParams(search).get(NEW_RECORD_PARAM) === '1';
}
