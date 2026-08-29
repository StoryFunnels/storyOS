/**
 * #451 — the words the seeder uses.
 *
 * Every name here is obviously fake on sight. That is a hard requirement, not
 * a style preference: screenshots out of Nadia's environment get pasted into
 * tickets, and nobody should ever have to stop and work out whether a client
 * name in one is real. "Northwind Consulting", never a plausible agency.
 */

export const CLIENT_NAMES = [
  'Northwind Consulting',
  'Contoso Creative',
  'Fabrikam Retail',
  'Litware Logistics',
  'Tailspin Toys',
  'Wingtip Wellness',
  'Adventure Works Travel',
  'Proseware Publishing',
  'Lucerne Legal',
  'Woodgrove Financial',
  'Fourth Coffee',
  'Graphic Design Institute',
  'Trey Research',
  'Blue Yonder Airlines',
] as const;

export const PERSON_NAMES = [
  'Ada Placeholder', 'Bruno Sample', 'Cleo Fixture', 'Dara Testcase', 'Emil Dummy',
  'Fenna Mockup', 'Gus Stubbs', 'Hana Example', 'Ivo Lorem', 'Juno Ipsum',
  'Kaz Filler', 'Lena Proxy', 'Milo Draft', 'Nia Sandbox', 'Osk Prototype',
  'Pim Scaffold', 'Quinn Seedling', 'Rae Boilerplate', 'Sten Template', 'Tuva Synthetic',
] as const;

export const PROJECT_WORDS = [
  'Rebrand', 'Website Refresh', 'Launch Campaign', 'Retainer', 'Audit',
  'Migration', 'Onboarding', 'Q3 Push', 'Brand Sprint', 'Content Engine',
  'Paid Social', 'Newsletter', 'Case Study', 'Product Video', 'Landing Page',
] as const;

export const TASK_VERBS = [
  'Draft', 'Review', 'Ship', 'Rework', 'Scope', 'Estimate', 'Storyboard',
  'Proofread', 'Schedule', 'Invoice', 'Chase', 'Archive', 'Repurpose', 'Brief',
] as const;

export const TASK_OBJECTS = [
  'the homepage copy', 'the Q3 report', 'the launch email', 'the pricing page',
  'the onboarding deck', 'the podcast intro', 'the case study', 'the ad set',
  'the style guide', 'the sitemap', 'the testimonial reel', 'the retainer scope',
] as const;

export const DOC_PARAGRAPHS = [
  'This document is synthetic seed content. It exists so that a screen with a long body of text has a long body of text to render, and for no other reason.',
  'Everything below was generated from a fixed seed. If two environments disagree about it, the seeder changed — the data did not drift on its own.',
  'The client asked for a shorter turnaround than the retainer covers. Noting it here so the scope conversation has somewhere to point.',
  'Open question: does the second phase come out of the same budget line, or is it a separate statement of work? Nobody has answered yet.',
  'Decision log: we are keeping the existing typography and replacing only the colour tokens. Revisit after the launch, not before.',
  'Handover notes. Assets live in the shared drive, credentials do not live anywhere near this document, and the schedule is in the linked project.',
  'This paragraph is deliberately long so that wrapping, truncation and the reading width of the document view are all exercised by real content rather than by a single short line that always fits, which is the condition under which layout bugs hide.',
] as const;

export const STATUS_OPTIONS = [
  'Backlog', 'Scoping', 'In Progress', 'Blocked', 'Client Review',
  'Revisions', 'Approved', 'Scheduled', 'Live', 'Invoiced', 'Archived',
] as const;

export const PRIORITY_OPTIONS = ['Low', 'Medium', 'High', 'Urgent'] as const;

export const TAG_OPTIONS = [
  'design', 'copy', 'video', 'paid', 'organic', 'urgent', 'retainer', 'overflow',
] as const;
