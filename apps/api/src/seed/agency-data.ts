/**
 * #1297 — Pinewood Studio: the dataset `seed:agency` writes.
 *
 * Pinewood Studio is a FAKE small marketing agency. Everything here is invented: the people, the
 * clients, the invoices, the email addresses (the reserved `.example` TLD, RFC 2606, which can never
 * be a real mailbox). Nothing is derived from a real client, customer, or from the real tracker. If
 * you add a name, make it up; do not borrow one.
 *
 * Pure data and no I/O, so two runs on the same day produce the same plan, byte for byte. Dates are
 * offsets from `today` (a whole UTC day), never calendar constants, so the workspace always reads as
 * "this week" however long ago it was first seeded.
 */

export const AGENCY_WORKSPACE = { name: 'Pinewood Studio', slug: 'pinewood-studio' } as const;
export const AGENCY_DOMAIN = 'pinewood.example';

export type MemberRole = 'admin' | 'member' | 'guest';

export interface CastMember {
  key: string;
  name: string;
  email: string;
  role: MemberRole;
}

/** The studio's people. `maya` creates the workspace (the workspace's first admin, its owner in practice); the rest are invited. */
export const STUDIO_CAST: CastMember[] = [
  { key: 'maya', name: 'Maya Chen', email: `maya.chen@${AGENCY_DOMAIN}`, role: 'admin' },
  { key: 'dana', name: 'Dana Okafor', email: `dana.okafor@${AGENCY_DOMAIN}`, role: 'admin' },
  { key: 'omar', name: 'Omar Haddad', email: `omar.haddad@${AGENCY_DOMAIN}`, role: 'member' },
  { key: 'lena', name: 'Lena Brandt', email: `lena.brandt@${AGENCY_DOMAIN}`, role: 'member' },
  { key: 'jonah', name: 'Jonah Whitfield', email: `jonah.whitfield@${AGENCY_DOMAIN}`, role: 'member' },
  // A client contact with a guest login: sees the client space only.
  { key: 'rosa', name: 'Rosa Alvarez', email: `rosa.alvarez@${AGENCY_DOMAIN}`, role: 'guest' },
];

/** One login per fleet agent, so each can sign in to the standing stack as a different kind of person. */
export const AGENT_LOGINS: CastMember[] = [
  { key: 'vera', name: 'Vera (agent login)', email: `vera@${AGENCY_DOMAIN}`, role: 'admin' },
  { key: 'marek', name: 'Marek (agent login)', email: `marek@${AGENCY_DOMAIN}`, role: 'admin' },
  { key: 'iris', name: 'Iris (agent login)', email: `iris@${AGENCY_DOMAIN}`, role: 'member' },
  { key: 'dara', name: 'Dara (agent login)', email: `dara@${AGENCY_DOMAIN}`, role: 'member' },
  { key: 'nils', name: 'Nils (agent login)', email: `nils@${AGENCY_DOMAIN}`, role: 'guest' },
];

export const PACKS = [
  { slug: 'agency-os', space: 'Client Work' },
  { slug: 'deal-desk', space: 'Sales' },
  { slug: 'team-board', space: 'Team' },
] as const;

/** The two databases the packs do not carry. Created in the Client Work space. */
export const EXTRA_DATABASES = [
  {
    name: 'Enquiries',
    description: 'People who asked what Pinewood could do for them, before they were a client.',
    fields: [
      { name: 'Source', type: 'select', options: ['Referral', 'Website form', 'Instagram', 'Cold outreach', 'Local event'] },
      { name: 'Stage', type: 'select', options: ['New', 'Qualified', 'Quoted', 'Won', 'Lost'] },
      { name: 'Contact Email', type: 'email' },
      { name: 'Budget', type: 'number' },
      { name: 'Received', type: 'date' },
    ],
  },
  {
    name: 'Invoices',
    description: 'What Pinewood has billed, and what is still owed.',
    fields: [
      { name: 'Amount', type: 'number' },
      { name: 'Issued', type: 'date' },
      { name: 'Due', type: 'date' },
      { name: 'Invoice Status', type: 'select', options: ['Draft', 'Sent', 'Paid', 'Overdue'] },
    ],
  },
] as const;

export interface PlannedRecord {
  /** Unique within its database: this is the identity the seed matches on, so re-runs add nothing. */
  title: string;
  /** Values keyed by field DISPLAY name. A string that names a select option is resolved to it; `@maya` etc. to a member. */
  values: Record<string, unknown>;
  /** Relation links: field display name -> titles of records in the other database. */
  links?: Record<string, string[]>;
  /** Days before today this record was created (daytime), for a believable history. */
  createdDaysAgo: number;
}

export interface AgencyData {
  clients: PlannedRecord[];
  contacts: PlannedRecord[];
  enquiries: PlannedRecord[];
  projects: PlannedRecord[];
  tasks: PlannedRecord[];
  quotes: PlannedRecord[];
  invoices: PlannedRecord[];
  teamTasks: PlannedRecord[];
  /** Comments an agent wrote, on a record, through the agent-token path the real agents use. */
  agentComments: Array<{ agent: string; database: 'Clients' | 'Tasks' | 'Projects'; record: string; text: string }>;
  /** The one draft quote whose creation fires the approval-gated rule, and the rule's own words. */
  approval: { quote: PlannedRecord; ruleName: string; commentTemplate: string };
}

export function isoDay(today: Date, offset: number): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
  return d.toISOString().slice(0, 10);
}

const mail = (user: string, host: string) => `${user}@${host}`;

export function buildAgencyData(today: Date): AgencyData {
  const day = (n: number) => isoDay(today, n);

  const client = (
    title: string, industry: string, health: string, status: string, value: number, sinceDaysAgo: number, owner: string, site: string,
  ): PlannedRecord => ({
    title,
    createdDaysAgo: sinceDaysAgo,
    values: {
      Status: status, Health: health, Industry: industry, Owner: owner, 'Monthly Value': value,
      'Client Since': day(-sinceDaysAgo), Website: `https://${site}`, 'Contact Email': mail('hello', site),
    },
  });

  const clients: PlannedRecord[] = [
    client('Maple Street Bakery', 'Local business', 'Great', 'Active', 2400, 410, '@dana', 'maplestreetbakery.example'),
    client('Harbor Dental', 'Local business', 'OK', 'Active', 3200, 340, '@maya', 'harbordental.example'),
    client('Kerr Plumbing', 'Local business', 'At risk', 'Active', 1800, 265, '@omar', 'kerrplumbing.example'),
    client('Lumen & Loom Furniture', 'E-commerce', 'Great', 'Active', 5200, 190, '@dana', 'lumenandloom.example'),
    client('Tidewater Coffee Roasters', 'E-commerce', 'OK', 'Onboarding', 2900, 24, '@lena', 'tidewaterroasters.example'),
    client('Brightpath Tutoring', 'Coaching', 'Great', 'Active', 1500, 120, '@jonah', 'brightpathtutoring.example'),
    client('Ironbark Fitness', 'Local business', 'On fire', 'Paused', 2100, 300, '@maya', 'ironbarkfitness.example'),
  ];

  const contact = (name: string, role: string, clientTitle: string, host: string, decider: boolean, ago: number): PlannedRecord => ({
    title: name,
    createdDaysAgo: ago,
    values: { Role: role, Email: mail(name.toLowerCase().replace(/[^a-z]+/g, '.'), host), 'Is Decision Maker': decider },
    links: { Client: [clientTitle] },
  });
  const contacts: PlannedRecord[] = [
    contact('Imogen Marsh', 'Owner', 'Maple Street Bakery', 'maplestreetbakery.example', true, 400),
    contact('Theo Marsh', 'Front of house', 'Maple Street Bakery', 'maplestreetbakery.example', false, 380),
    contact('Dr. Priya Raman', 'Practice owner', 'Harbor Dental', 'harbordental.example', true, 330),
    contact('Carlos Mendes', 'Office manager', 'Harbor Dental', 'harbordental.example', false, 320),
    contact('Bill Kerr', 'Owner', 'Kerr Plumbing', 'kerrplumbing.example', true, 260),
    contact('Noor Haddad', 'Marketing lead', 'Lumen & Loom Furniture', 'lumenandloom.example', true, 185),
    contact('Felix Ostrander', 'Head of e-commerce', 'Lumen & Loom Furniture', 'lumenandloom.example', false, 180),
    contact('Greta Lindqvist', 'Founder', 'Tidewater Coffee Roasters', 'tidewaterroasters.example', true, 22),
    contact('Samir Qureshi', 'Founder', 'Brightpath Tutoring', 'brightpathtutoring.example', true, 118),
    contact('Tamsin Rowe', 'Studio manager', 'Ironbark Fitness', 'ironbarkfitness.example', true, 295),
    contact('Joe Ironside', 'Owner', 'Ironbark Fitness', 'ironbarkfitness.example', true, 290),
  ];

  const enquiry = (
    title: string, source: string, stage: string, budget: number, ago: number, host: string,
  ): PlannedRecord => ({
    title,
    createdDaysAgo: ago,
    values: {
      Source: source, Stage: stage, Budget: budget, Received: day(-ago),
      'Contact Email': mail('info', host),
    },
  });
  const enquiries: PlannedRecord[] = [
    enquiry('Foxglove Florist: new website', 'Instagram', 'New', 4000, 1, 'foxglovefloral.example'),
    enquiry('Redwood Climbing Gym: launch campaign', 'Website form', 'New', 6500, 2, 'redwoodclimbing.example'),
    enquiry('Penny Lane Pet Supplies: email flows', 'Referral', 'Qualified', 3000, 4, 'pennylanepets.example'),
    enquiry('Saltmarsh Brewing: label refresh', 'Local event', 'Qualified', 5500, 6, 'saltmarshbrewing.example'),
    enquiry('Quarry Hill Vineyard: tasting-room site', 'Referral', 'Quoted', 9000, 9, 'quarryhillwine.example'),
    enquiry('Birchwood Physio: local search', 'Cold outreach', 'Quoted', 2200, 12, 'birchwoodphysio.example'),
    enquiry('Corner Cobbler: Google Business profile', 'Website form', 'Won', 900, 18, 'cornercobbler.example'),
    enquiry('Alder & Ash Joinery: portfolio site', 'Referral', 'Won', 7200, 25, 'alderandash.example'),
    enquiry('Little Acorn Nursery: open-day posters', 'Local event', 'Lost', 700, 31, 'littleacorn.example'),
    enquiry('Sunday Roast Pub: menu redesign', 'Cold outreach', 'Lost', 1400, 38, 'sundayroastpub.example'),
    enquiry('Hollow Oak Books: newsletter', 'Instagram', 'Qualified', 1800, 5, 'hollowoakbooks.example'),
    enquiry('Marlow Motors: used-car landing pages', 'Website form', 'New', 8000, 0, 'marlowmotors.example'),
  ];

  const job = (
    title: string, clientTitle: string, status: string, lead: string, budget: number, dueIn: number, ago: number,
  ): PlannedRecord => ({
    title,
    createdDaysAgo: ago,
    values: { Status: status, Lead: lead, Budget: budget, 'Due Date': day(dueIn) },
    links: { Client: [clientTitle] },
  });
  const projects: PlannedRecord[] = [
    job('Maple Street: spring menu campaign', 'Maple Street Bakery', 'Active', '@dana', 3200, 12, 30),
    job('Maple Street: loyalty card redesign', 'Maple Street Bakery', 'Delivered', '@lena', 1400, -20, 75),
    job('Harbor Dental: new patient landing page', 'Harbor Dental', 'Active', '@omar', 4800, 9, 28),
    job('Harbor Dental: recall email series', 'Harbor Dental', 'Planning', '@maya', 2600, 30, 8),
    job('Kerr Plumbing: van wrap artwork', 'Kerr Plumbing', 'On Hold', '@omar', 1900, -4, 70),
    job('Lumen & Loom: autumn lookbook', 'Lumen & Loom Furniture', 'Active', '@dana', 8400, 18, 40),
    job('Lumen & Loom: product photography brief', 'Lumen & Loom Furniture', 'Scoping', '@jonah', 3000, 45, 4),
    job('Tidewater: brand identity', 'Tidewater Coffee Roasters', 'Active', '@lena', 7500, 21, 22),
    job('Tidewater: Shopify store build', 'Tidewater Coffee Roasters', 'Planning', '@omar', 9600, 50, 10),
    job('Brightpath: open-evening flyers', 'Brightpath Tutoring', 'Delivered', '@jonah', 900, -9, 35),
    job('Brightpath: parent newsletter template', 'Brightpath Tutoring', 'Active', '@jonah', 1100, 6, 14),
    job('Ironbark: January offer campaign', 'Ironbark Fitness', 'Closed', '@maya', 2400, -60, 110),
  ];

  const task = (
    title: string, projectTitle: string, state: string, priority: string, assignee: string, dueIn: number, ago: number, labels: string[] = [],
  ): PlannedRecord => ({
    title,
    createdDaysAgo: ago,
    values: { State: state, Priority: priority, Assignee: assignee, 'Due Date': day(dueIn), ...(labels.length ? { Labels: labels } : {}) },
    links: { Project: [projectTitle] },
  });
  const P = {
    maple: 'Maple Street: spring menu campaign', harbor: 'Harbor Dental: new patient landing page',
    harborEmail: 'Harbor Dental: recall email series', lumen: 'Lumen & Loom: autumn lookbook',
    tide: 'Tidewater: brand identity', tideShop: 'Tidewater: Shopify store build',
    bright: 'Brightpath: parent newsletter template', kerr: 'Kerr Plumbing: van wrap artwork',
  };
  const tasks: PlannedRecord[] = [
    task('Photograph the spring pastry range', P.maple, 'In Progress', 'High', '@lena', 3, 10, ['design']),
    task('Write the menu launch email', P.maple, 'To Do', 'Medium', '@jonah', 5, 9, ['copy']),
    task('Order window decals from the printer', P.maple, 'Backlog', 'Low', '@omar', 10, 9),
    task('Wireframe the new-patient page', P.harbor, 'In Review', 'High', '@omar', 2, 20, ['design']),
    task('Write page copy for implants and whitening', P.harbor, 'In Progress', 'Medium', '@jonah', 4, 18, ['copy', 'client-waiting']),
    task('Hook the booking widget into the page', P.harbor, 'To Do', 'High', '@omar', 7, 14, ['dev']),
    task('Draft the three recall emails', P.harborEmail, 'Triage', 'Medium', '@maya', 14, 6, ['copy']),
    task('Chase Kerr for approval of the van artwork', P.kerr, 'In Progress', 'Urgent', '@omar', -3, 40, ['client-waiting']),
    task('Send the revised van wrap proofs', P.kerr, 'To Do', 'High', '@lena', -1, 12, ['design']),
    task('Lay out the lookbook spreads', P.lumen, 'In Progress', 'High', '@lena', 6, 25, ['design']),
    task('Write captions for twelve products', P.lumen, 'In Progress', 'Medium', '@jonah', 8, 22, ['copy']),
    task('Book the photographer for the shoot day', P.lumen, 'Done', 'High', '@dana', -12, 30),
    task('Proof the first print run', P.lumen, 'Backlog', 'Medium', '@dana', 16, 15),
    task('Present three logo routes to Greta', P.tide, 'In Review', 'Urgent', '@lena', 1, 15, ['design']),
    task('Draft the brand voice one-pager', P.tide, 'In Progress', 'Medium', '@jonah', 9, 12, ['copy']),
    task('Collect competitor packaging for reference', P.tide, 'Done', 'Low', '@lena', -8, 21),
    task('Scope the Shopify theme and apps', P.tideShop, 'To Do', 'Medium', '@omar', 12, 6, ['dev']),
    task('Write product descriptions for the first six roasts', P.tideShop, 'Backlog', 'Low', '@jonah', 25, 5, ['copy']),
    task('Set up the newsletter template in the email tool', P.bright, 'In Progress', 'Medium', '@jonah', 3, 9, ['dev']),
    task('Get Samir to approve the header image', P.bright, 'To Do', 'Low', '@jonah', 4, 8, ['client-waiting']),
    task('Monthly analytics summary for Maple Street', P.maple, 'Done', 'Low', '@dana', -6, 20),
    task('Fix the contact form on the old Harbor site', P.harbor, 'Done', 'High', '@omar', -15, 35, ['dev']),
    task('Schedule the autumn social posts', P.lumen, 'To Do', 'Medium', '@lena', 11, 4),
    task('Review Tidewater photography moodboard', P.tide, 'Triage', 'Low', '@maya', 13, 2),
  ];

  const quote = (title: string, validIn: number, ago: number): PlannedRecord => ({
    title, createdDaysAgo: ago, values: { 'Valid until': day(validIn) },
  });
  const quotes: PlannedRecord[] = [
    quote('Quote: Quarry Hill Vineyard tasting-room site', 12, 9),
    quote('Quote: Birchwood Physio local search', 5, 12),
    quote('Quote: Lumen & Loom winter campaign', 20, 7),
    quote('Quote: Tidewater Shopify store build', -3, 30),
    quote('Quote: Maple Street seasonal photography', 14, 5),
    quote('Quote: Alder & Ash Joinery portfolio site', -10, 26),
    quote('Quote: Brightpath term-time ad package', 9, 4),
    quote('Quote: Penny Lane Pet Supplies email flows', 16, 3),
  ];

  const invoice = (
    title: string, clientTitle: string, amount: number, issued: number, dueIn: number, status: string,
  ): PlannedRecord => ({
    title,
    createdDaysAgo: -issued,
    values: { Amount: amount, Issued: day(issued), Due: day(dueIn), 'Invoice Status': status },
    links: { Client: [clientTitle] },
  });
  const invoices: PlannedRecord[] = [
    invoice('INV-1041 Maple Street, March retainer', 'Maple Street Bakery', 2400, -45, -15, 'Paid'),
    invoice('INV-1042 Harbor Dental, March retainer', 'Harbor Dental', 3200, -44, -14, 'Paid'),
    invoice('INV-1047 Lumen & Loom, lookbook deposit', 'Lumen & Loom Furniture', 4200, -30, 0, 'Paid'),
    invoice('INV-1049 Kerr Plumbing, artwork stage one', 'Kerr Plumbing', 950, -28, -7, 'Overdue'),
    invoice('INV-1052 Maple Street, April retainer', 'Maple Street Bakery', 2400, -15, 15, 'Sent'),
    invoice('INV-1053 Harbor Dental, April retainer', 'Harbor Dental', 3200, -14, 16, 'Sent'),
    invoice('INV-1055 Tidewater, brand identity deposit', 'Tidewater Coffee Roasters', 3750, -6, 24, 'Sent'),
    invoice('INV-1056 Brightpath, newsletter template', 'Brightpath Tutoring', 1100, -1, 29, 'Draft'),
  ];

  const teamTasks: PlannedRecord[] = [
    { title: 'Renew the studio design-software licences', createdDaysAgo: 8, values: { Status: 'To Do', Assignee: '@maya', 'Due date': day(6) } },
    { title: 'Tidy the shared asset folders before the audit', createdDaysAgo: 5, values: { Status: 'In Progress', Assignee: '@dana', 'Due date': day(2) } },
    { title: 'Book the Friday studio lunch', createdDaysAgo: 2, values: { Status: 'Done', Assignee: '@lena', 'Due date': day(-1) } },
    { title: 'Write down how we run client handovers', createdDaysAgo: 1, values: { Status: 'To Do', Assignee: '@omar', 'Due date': day(14) } },
  ];

  const agentComments: AgencyData['agentComments'] = [
    {
      agent: 'Brief Writer', database: 'Clients', record: 'Tidewater Coffee Roasters',
      text: 'Drafted the welcome packet: a friendly intro from Maya, the first-week checklist (brand questionnaire, asset hand-over, kickoff call) and a short list of what Greta needs to send us. Nothing has gone to the client.',
    },
    {
      agent: 'Brief Writer', database: 'Tasks', record: 'Present three logo routes to Greta',
      text: 'Checked the three routes against the brand questionnaire. Route two is the only one that reads well at small sizes on a bag label; suggest leading with it.',
    },
    {
      agent: 'Invoice Checker', database: 'Projects', record: 'Kerr Plumbing: van wrap artwork',
      text: 'INV-1049 for this job is 7 days overdue and the project is on hold. Worth a call from Omar before more artwork is produced.',
    },
  ];

  const approval: AgencyData['approval'] = {
    quote: quote('Quote: Harbor Dental recall campaign (draft)', 21, 0),
    ruleName: 'Chase an unanswered quote',
    commentTemplate: 'Hi, just checking you have had a chance to look at {Title}. Happy to walk through it on a call.',
  };

  return { clients, contacts, enquiries, projects, tasks, quotes, invoices, teamTasks, agentComments, approval };
}

export function countAgencyRecords(data: AgencyData): number {
  return (
    data.clients.length + data.contacts.length + data.enquiries.length + data.projects.length + data.tasks.length +
    data.quotes.length + data.invoices.length + data.teamTasks.length + 1
  );
}
