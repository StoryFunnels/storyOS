import type { ReactNode } from 'react';

/**
 * The Settings page column (ticket #1186, Dara's shell scope from ticket #1216): ONE place for where a Settings page sits.
 *
 * Ticket #1216 (PR #1409) moved the Settings menu into the app sidebar and deleted this file, which had held the menu column, so every page
 * was left centred at 768px inside the pane (136px of empty space to the left of the title). The prototype's page column is LEFT-aligned
 * in the pane: 28px from the sidebar, 22px under the top edge (so the 18px/700 title's top is 31px in a 1270px window), a content column of at most 720px.
 *
 * Every Settings page still draws its own root (`mx-auto max-w-3xl p-4 sm:p-8`, and a few their own width). Rather than edit all of them
 * (and conflict with the other Settings tickets, #1187 to #1189), this wrapper takes over the three things that decide the column
 * (centring, padding, width) from whatever the page's root asks for. A page added later gets the column without having to know. Below
 * the `sm` breakpoint the gutter stays 16px, as the pages had it.
 *
 * Consequence to know: a page that asked for more than 720px (the audit log and the integrations hub were `max-w-4xl`) is now held to 720,
 * as the prototype draws every page. A page that truly needs room can opt out by moving out of this layout, not by overriding it.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="settings-column"
      className="box-content max-w-[720px] px-4 pb-8 pt-4 sm:px-7 sm:pt-[22px] [&>*]:mx-0! [&>*]:max-w-none! [&>*]:p-0!"
    >
      {children}
    </div>
  );
}
