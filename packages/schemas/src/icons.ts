/**
 * Curated StoryOS icon set — shared metadata (#133, #251).
 *
 * Zod-free on purpose, same reason as ./markdown: the MCP package imports this
 * by subpath so it doesn't inline a CJS `require('zod')` into its ESM bundle.
 *
 * This module is the *data* source of truth (name/category/keywords + the
 * `set:<name>` storage convention). apps/web's icon-set.tsx pairs each name
 * with its lucide-react component; apps/api and packages/mcp use this module
 * directly for the emoji migration backfill (#251) and MCP tool schemas —
 * neither of those runs React, so they never need the icon components.
 */

export type IconCategory =
  | 'work'
  | 'tasks'
  | 'people'
  | 'content'
  | 'data'
  | 'comms'
  | 'objects'
  | 'nature'
  | 'status';

export const ICON_CATEGORIES: { id: IconCategory; label: string }[] = [
  { id: 'work', label: 'Work' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'people', label: 'People' },
  { id: 'content', label: 'Content' },
  { id: 'data', label: 'Data' },
  { id: 'comms', label: 'Comms' },
  { id: 'objects', label: 'Objects' },
  { id: 'nature', label: 'Nature' },
  { id: 'status', label: 'Status' },
];

export interface IconMeta {
  name: string;
  categories: IconCategory[];
  keywords: string;
}

/** The 134 curated icon names. Keep in lockstep with apps/web's ICON_SET —
 * that file imports `ICON_SET_META` from here and zips it with lucide-react
 * components, so this array (not that one) is the source of truth for names,
 * categories and keywords. */
export const ICON_SET_META: IconMeta[] = [
  { name: 'briefcase', categories: ['work'], keywords: 'briefcase job' },
  { name: 'folder-kanban', categories: ['work'], keywords: 'project board kanban' },
  { name: 'layout-dashboard', categories: ['work'], keywords: 'dashboard overview' },
  { name: 'target', categories: ['work'], keywords: 'goal target objective' },
  { name: 'rocket', categories: ['work'], keywords: 'launch release ship' },
  { name: 'flag', categories: ['work', 'status'], keywords: 'flag milestone priority' },
  { name: 'milestone', categories: ['work'], keywords: 'milestone marker' },
  { name: 'trophy', categories: ['work'], keywords: 'win award trophy' },
  { name: 'compass', categories: ['work'], keywords: 'strategy direction compass' },
  { name: 'map', categories: ['work'], keywords: 'roadmap map plan' },
  { name: 'building2', categories: ['work', 'people'], keywords: 'company office building' },
  { name: 'goal', categories: ['work'], keywords: 'goal' },
  { name: 'square-check', categories: ['tasks'], keywords: 'task done check complete' },
  { name: 'check-square', categories: ['tasks'], keywords: 'task done check complete' },
  { name: 'list-todo', categories: ['tasks'], keywords: 'todo list tasks' },
  { name: 'list-checks', categories: ['tasks'], keywords: 'checklist tasks' },
  { name: 'clock', categories: ['tasks'], keywords: 'time clock' },
  { name: 'calendar-days', categories: ['tasks'], keywords: 'calendar date schedule' },
  { name: 'calendar-clock', categories: ['tasks'], keywords: 'deadline schedule calendar' },
  { name: 'alarm-clock', categories: ['tasks'], keywords: 'alarm reminder deadline' },
  { name: 'hourglass', categories: ['tasks'], keywords: 'waiting pending' },
  { name: 'timer', categories: ['tasks'], keywords: 'timer duration' },
  { name: 'repeat', categories: ['tasks'], keywords: 'recurring repeat loop' },
  { name: 'circle-dashed', categories: ['tasks', 'status'], keywords: 'backlog pending' },
  { name: 'users', categories: ['people'], keywords: 'team members people' },
  { name: 'user', categories: ['people'], keywords: 'person user' },
  { name: 'user-round', categories: ['people'], keywords: 'person user' },
  { name: 'users-round', categories: ['people'], keywords: 'team members' },
  { name: 'contact', categories: ['people'], keywords: 'contact crm' },
  { name: 'handshake', categories: ['people'], keywords: 'deal client partnership' },
  { name: 'user-plus', categories: ['people'], keywords: 'invite add user' },
  { name: 'crown', categories: ['people', 'status'], keywords: 'owner admin vip' },
  { name: 'baby', categories: ['people'], keywords: 'lead new' },
  { name: 'file-text', categories: ['content'], keywords: 'document note file' },
  { name: 'files', categories: ['content'], keywords: 'documents files folders folder' },
  { name: 'notebook', categories: ['content'], keywords: 'notebook notes' },
  { name: 'notebook-pen', categories: ['content'], keywords: 'draft writing notes' },
  { name: 'book-open', categories: ['content'], keywords: 'docs guide read education knowledge' },
  { name: 'book', categories: ['content'], keywords: 'book manuscript' },
  { name: 'newspaper', categories: ['content'], keywords: 'articles blog news press' },
  { name: 'pen-tool', categories: ['content'], keywords: 'design pen draw author' },
  { name: 'pencil', categories: ['content'], keywords: 'edit write draft' },
  { name: 'feather', categories: ['content'], keywords: 'author writing light' },
  { name: 'image', categories: ['content'], keywords: 'picture image' },
  { name: 'camera', categories: ['content'], keywords: 'photo camera' },
  { name: 'film', categories: ['content'], keywords: 'video film' },
  { name: 'clapperboard', categories: ['content'], keywords: 'video production clapper' },
  { name: 'mic', categories: ['content'], keywords: 'podcast audio record speaking voice' },
  { name: 'music', categories: ['content'], keywords: 'music audio' },
  { name: 'palette', categories: ['content'], keywords: 'design art color' },
  { name: 'brush', categories: ['content'], keywords: 'paint design' },
  { name: 'database', categories: ['data'], keywords: 'database records' },
  { name: 'table', categories: ['data'], keywords: 'table grid data' },
  { name: 'table2', categories: ['data'], keywords: 'table grid' },
  { name: 'chart-bar', categories: ['data'], keywords: 'bar chart analytics' },
  { name: 'chart-line', categories: ['data'], keywords: 'line chart trend growth' },
  { name: 'chart-pie', categories: ['data'], keywords: 'pie chart share' },
  { name: 'trending-up', categories: ['data'], keywords: 'growth trend up' },
  { name: 'activity', categories: ['data'], keywords: 'activity pulse metrics' },
  { name: 'boxes', categories: ['data'], keywords: 'inventory items' },
  { name: 'package', categories: ['data'], keywords: 'package deliverable box' },
  { name: 'archive', categories: ['data'], keywords: 'archive storage' },
  { name: 'layers', categories: ['data'], keywords: 'layers stack foundation' },
  { name: 'grid3x3', categories: ['data'], keywords: 'grid gallery' },
  { name: 'filter', categories: ['data'], keywords: 'filter' },
  { name: 'message-square', categories: ['comms'], keywords: 'comment chat message request' },
  { name: 'message-circle', categories: ['comms'], keywords: 'chat message' },
  { name: 'mail', categories: ['comms'], keywords: 'email mail envelope' },
  { name: 'send', categories: ['comms'], keywords: 'send message' },
  { name: 'bell', categories: ['comms', 'status'], keywords: 'notification alert' },
  { name: 'megaphone', categories: ['comms'], keywords: 'marketing announce announcement platform' },
  { name: 'phone', categories: ['comms'], keywords: 'call phone' },
  { name: 'at-sign', categories: ['comms'], keywords: 'mention email' },
  { name: 'hash', categories: ['comms'], keywords: 'tag channel hashtag' },
  { name: 'wrench', categories: ['objects'], keywords: 'tools fix chore developer coding' },
  { name: 'settings', categories: ['objects'], keywords: 'settings config gear' },
  { name: 'cog', categories: ['objects'], keywords: 'gear settings' },
  { name: 'hammer', categories: ['objects'], keywords: 'build hammer' },
  { name: 'bug', categories: ['objects', 'status'], keywords: 'bug issue defect' },
  { name: 'flask-conical', categories: ['objects'], keywords: 'experiment test lab' },
  { name: 'test-tube', categories: ['objects'], keywords: 'test experiment' },
  { name: 'link', categories: ['objects'], keywords: 'link relation url chain' },
  { name: 'key', categories: ['objects'], keywords: 'key access secret' },
  { name: 'lock', categories: ['objects'], keywords: 'lock secure private' },
  { name: 'shield-check', categories: ['objects', 'status'], keywords: 'security verified safe' },
  { name: 'zap', categories: ['objects'], keywords: 'automation fast energy lightning' },
  { name: 'plug', categories: ['objects'], keywords: 'integration connect' },
  { name: 'puzzle', categories: ['objects'], keywords: 'puzzle module addon' },
  { name: 'wand', categories: ['objects'], keywords: 'magic wand auto' },
  { name: 'sparkles', categories: ['objects', 'nature'], keywords: 'magic ai sparkle idea special unicorn' },
  { name: 'gift', categories: ['objects'], keywords: 'gift bonus reward' },
  { name: 'shopping-cart', categories: ['objects'], keywords: 'cart order shop' },
  { name: 'credit-card', categories: ['objects'], keywords: 'payment billing card' },
  { name: 'receipt', categories: ['objects'], keywords: 'invoice receipt proposal' },
  { name: 'dollar-sign', categories: ['objects'], keywords: 'money sales revenue opportunity' },
  { name: 'wallet', categories: ['objects'], keywords: 'wallet budget expense' },
  { name: 'coins', categories: ['objects'], keywords: 'money coins' },
  { name: 'tag', categories: ['objects'], keywords: 'tag label' },
  { name: 'tags', categories: ['objects'], keywords: 'tags labels' },
  { name: 'bookmark', categories: ['objects'], keywords: 'bookmark save' },
  { name: 'paperclip', categories: ['objects'], keywords: 'attachment file' },
  { name: 'pin', categories: ['objects'], keywords: 'pin fixed moment' },
  { name: 'star', categories: ['objects', 'status'], keywords: 'favorite star' },
  { name: 'heart', categories: ['objects', 'status'], keywords: 'health favorite care' },
  { name: 'sprout', categories: ['nature'], keywords: 'growth seedling start' },
  { name: 'leaf', categories: ['nature'], keywords: 'plant eco leaf herb clover' },
  { name: 'tree-pine', categories: ['nature'], keywords: 'tree nature' },
  { name: 'flower2', categories: ['nature'], keywords: 'flower bloom' },
  { name: 'sun', categories: ['nature'], keywords: 'day sun light time-off vacation' },
  { name: 'moon', categories: ['nature'], keywords: 'night moon' },
  { name: 'cloud', categories: ['nature'], keywords: 'cloud weather' },
  { name: 'waves', categories: ['nature'], keywords: 'ocean funnel flow wave' },
  { name: 'flame', categories: ['nature', 'status'], keywords: 'hot fire priority' },
  { name: 'droplet', categories: ['nature'], keywords: 'water drop' },
  { name: 'mountain', categories: ['nature'], keywords: 'mountain peak goal' },
  { name: 'snowflake', categories: ['nature'], keywords: 'cold freeze' },
  { name: 'bird', categories: ['nature'], keywords: 'bird bee busy' },
  { name: 'home', categories: ['nature'], keywords: 'home house' },
  { name: 'plane', categories: ['nature'], keywords: 'travel plane' },
  { name: 'globe', categories: ['nature'], keywords: 'world global web' },
  { name: 'map-pin', categories: ['nature'], keywords: 'location place' },
  { name: 'coffee', categories: ['nature'], keywords: 'coffee meeting break meetings' },
  { name: 'circle-check', categories: ['status'], keywords: 'done complete success' },
  { name: 'circle-alert', categories: ['status'], keywords: 'warning alert' },
  { name: 'circle-x', categories: ['status'], keywords: 'error blocked cancel' },
  { name: 'circle-dot', categories: ['status'], keywords: 'active in-progress' },
  { name: 'circle', categories: ['status'], keywords: 'open empty' },
  { name: 'triangle-alert', categories: ['status'], keywords: 'warning risk' },
  { name: 'ban', categories: ['status'], keywords: 'blocked banned' },
  { name: 'eye', categories: ['status'], keywords: 'watch review visible' },
  { name: 'eye-off', categories: ['status'], keywords: 'hidden' },
  { name: 'thumbs-up', categories: ['status'], keywords: 'approve like' },
  { name: 'loader', categories: ['status'], keywords: 'loading progress' },
  { name: 'pause', categories: ['status'], keywords: 'paused hold' },
];

export const ICON_NAMES: Set<string> = new Set(ICON_SET_META.map((d) => d.name));

/** Stored-value convention: `set:<name>` is a curated icon; anything else is
 * emoji/text (MN-208). */
export const ICON_SET_PREFIX = 'set:';

/** Extract the curated-set name from a stored icon value, or null if it's not
 * a (recognized) curated ref. */
export function setIconName(value?: string | null): string | null {
  if (!value || !value.startsWith(ICON_SET_PREFIX)) return null;
  const name = value.slice(ICON_SET_PREFIX.length);
  return ICON_NAMES.has(name) ? name : null;
}

/** True for any `set:<name>` ref, recognized or not — used to skip already-
 * migrated values during the emoji backfill (#251) without re-validating the
 * name against the current set. */
export function isSetIconRef(value?: string | null): boolean {
  return Boolean(value && value.startsWith(ICON_SET_PREFIX));
}

export interface BrandIconMeta {
  /** File-name-safe slug, e.g. "x-twitter" — also the vendored SVG's filename
   * under apps/web/public/brand-icons/<slug>.svg. */
  slug: string;
  /** Human-readable display name shown in the picker/tooltips. */
  name: string;
  /** Space-separated search terms (lowercase) — matched the same way as
   * ICON_SET_META.keywords: substring match against the search query. */
  keywords: string;
}

/**
 * Third-party platform logos (#298) — a second namespace alongside the
 * curated lucide `set:` icons, for "this is our LinkedIn workspace" / "this
 * connects to Notion" style use cases that a generic glyph can't express.
 *
 * ~100 marks sourced from Simple Icons (simpleicons.org, npm package
 * `simple-icons`, CC0-licensed — https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md),
 * vendored as static SVGs one-per-file under apps/web/public/brand-icons/,
 * named by slug. Curated for a work-OS / marketing-agency audience: social,
 * dev/eng, productivity, business/marketing, web/CMS, infra/AI, and CRM/ops
 * tooling. A handful of well-known marks (LinkedIn, Slack, Microsoft's and
 * Adobe's product suites, AWS, Salesforce) are NOT in this set because Simple
 * Icons no longer ships them (brand-requested removals, per its own
 * DISCLAIMER.md) — rather than hand-draw those trademarked logos from
 * scratch, they were substituted with other real, CC0-licensed marks in the
 * same category.
 *
 * Plus two hand-recreated entries for StoryOS's own sibling products —
 * storyfunnels and storypages — drawn fresh from their public marketing
 * sites (not traced/scraped from a source file) since neither is in any
 * public icon library.
 *
 * Same zod-free-module reasoning as ICON_SET_META above: this is the single
 * source of truth for both apps/web's picker (icon-picker.tsx) and
 * packages/mcp's list_icon_set tool (buildIconCatalog in tools.ts), so the
 * two never drift.
 */
export const BRAND_ICON_META: BrandIconMeta[] = [
  { slug: 'x-twitter', name: 'X (Twitter)', keywords: 'x twitter social tweet' },
  { slug: 'facebook', name: 'Facebook', keywords: 'facebook meta social' },
  { slug: 'instagram', name: 'Instagram', keywords: 'instagram ig social photo' },
  { slug: 'tiktok', name: 'TikTok', keywords: 'tiktok social video short-form' },
  { slug: 'youtube', name: 'YouTube', keywords: 'youtube video social google' },
  { slug: 'pinterest', name: 'Pinterest', keywords: 'pinterest social pins boards' },
  { slug: 'reddit', name: 'Reddit', keywords: 'reddit social forum community' },
  { slug: 'discord', name: 'Discord', keywords: 'discord chat community voice' },
  { slug: 'telegram', name: 'Telegram', keywords: 'telegram chat messaging' },
  { slug: 'whatsapp', name: 'WhatsApp', keywords: 'whatsapp chat messaging meta' },
  { slug: 'threads', name: 'Threads', keywords: 'threads meta social' },
  { slug: 'snapchat', name: 'Snapchat', keywords: 'snapchat social' },
  { slug: 'github', name: 'GitHub', keywords: 'github git code repo version-control' },
  { slug: 'gitlab', name: 'GitLab', keywords: 'gitlab git code repo ci-cd' },
  { slug: 'bitbucket', name: 'Bitbucket', keywords: 'bitbucket git atlassian repo' },
  { slug: 'linear', name: 'Linear', keywords: 'linear issues project-management engineering' },
  { slug: 'jira', name: 'Jira', keywords: 'jira atlassian issues project-management' },
  { slug: 'confluence', name: 'Confluence', keywords: 'confluence atlassian docs wiki' },
  { slug: 'docker', name: 'Docker', keywords: 'docker container devops' },
  { slug: 'vercel', name: 'Vercel', keywords: 'vercel hosting deploy nextjs' },
  { slug: 'netlify', name: 'Netlify', keywords: 'netlify hosting deploy jamstack' },
  { slug: 'cloudflare', name: 'Cloudflare', keywords: 'cloudflare cdn dns security' },
  { slug: 'npm', name: 'npm', keywords: 'npm node package javascript' },
  { slug: 'postgresql', name: 'PostgreSQL', keywords: 'postgres postgresql database sql' },
  { slug: 'mongodb', name: 'MongoDB', keywords: 'mongodb mongo database nosql' },
  { slug: 'redis', name: 'Redis', keywords: 'redis cache database' },
  { slug: 'notion', name: 'Notion', keywords: 'notion docs wiki workspace' },
  { slug: 'figma', name: 'Figma', keywords: 'figma design ui ux' },
  { slug: 'airtable', name: 'Airtable', keywords: 'airtable database spreadsheet' },
  { slug: 'asana', name: 'Asana', keywords: 'asana tasks project-management' },
  { slug: 'trello', name: 'Trello', keywords: 'trello board kanban tasks' },
  { slug: 'clickup', name: 'ClickUp', keywords: 'clickup tasks project-management' },
  { slug: 'coda', name: 'Coda', keywords: 'coda docs workspace' },
  { slug: 'miro', name: 'Miro', keywords: 'miro whiteboard collaboration' },
  { slug: 'loom', name: 'Loom', keywords: 'loom video recording screen-record' },
  { slug: 'zoom', name: 'Zoom', keywords: 'zoom video call meeting' },
  { slug: 'googledrive', name: 'Google Drive', keywords: 'google drive storage files' },
  { slug: 'googlesheets', name: 'Google Sheets', keywords: 'google sheets spreadsheet' },
  { slug: 'googledocs', name: 'Google Docs', keywords: 'google docs document' },
  { slug: 'googlecalendar', name: 'Google Calendar', keywords: 'google calendar schedule' },
  { slug: 'gmail', name: 'Gmail', keywords: 'gmail google email mail' },
  { slug: 'googlemeet', name: 'Google Meet', keywords: 'google meet video call' },
  { slug: 'hubspot', name: 'HubSpot', keywords: 'hubspot crm marketing sales' },
  { slug: 'stripe', name: 'Stripe', keywords: 'stripe payments billing' },
  { slug: 'shopify', name: 'Shopify', keywords: 'shopify ecommerce store' },
  { slug: 'mailchimp', name: 'Mailchimp', keywords: 'mailchimp email marketing newsletter' },
  { slug: 'zapier', name: 'Zapier', keywords: 'zapier automation integration workflow' },
  { slug: 'googleanalytics', name: 'Google Analytics', keywords: 'google analytics ga traffic' },
  { slug: 'semrush', name: 'Semrush', keywords: 'semrush seo marketing' },
  { slug: 'googleads', name: 'Google Ads', keywords: 'google ads advertising ppc' },
  { slug: 'quickbooks', name: 'QuickBooks', keywords: 'quickbooks accounting finance' },
  { slug: 'xero', name: 'Xero', keywords: 'xero accounting finance' },
  { slug: 'paypal', name: 'PayPal', keywords: 'paypal payments' },
  { slug: 'braintree', name: 'Braintree', keywords: 'braintree payments' },
  { slug: 'visa', name: 'Visa', keywords: 'visa card payment' },
  { slug: 'mastercard', name: 'Mastercard', keywords: 'mastercard card payment' },
  { slug: 'buffer', name: 'Buffer', keywords: 'buffer social media scheduling' },
  { slug: 'hootsuite', name: 'Hootsuite', keywords: 'hootsuite social media scheduling' },
  { slug: 'typeform', name: 'Typeform', keywords: 'typeform forms survey' },
  { slug: 'surveymonkey', name: 'SurveyMonkey', keywords: 'surveymonkey survey forms' },
  { slug: 'webflow', name: 'Webflow', keywords: 'webflow website builder cms' },
  { slug: 'wordpress', name: 'WordPress', keywords: 'wordpress cms blog website' },
  { slug: 'squarespace', name: 'Squarespace', keywords: 'squarespace website builder' },
  { slug: 'wix', name: 'Wix', keywords: 'wix website builder' },
  { slug: 'framer', name: 'Framer', keywords: 'framer design website prototyping' },
  { slug: 'ghost', name: 'Ghost', keywords: 'ghost blog cms publishing' },
  { slug: 'googlecloud', name: 'Google Cloud', keywords: 'google cloud gcp infrastructure' },
  { slug: 'kubernetes', name: 'Kubernetes', keywords: 'kubernetes k8s container orchestration' },
  { slug: 'grafana', name: 'Grafana', keywords: 'grafana monitoring dashboard metrics' },
  { slug: 'sentry', name: 'Sentry', keywords: 'sentry error-tracking monitoring' },
  { slug: 'datadog', name: 'Datadog', keywords: 'datadog monitoring observability' },
  { slug: 'auth0', name: 'Auth0', keywords: 'auth0 authentication identity' },
  { slug: 'digitalocean', name: 'DigitalOcean', keywords: 'digitalocean cloud hosting' },
  { slug: 'okta', name: 'Okta', keywords: 'okta identity sso authentication' },
  { slug: 'anthropic', name: 'Anthropic', keywords: 'anthropic ai claude' },
  { slug: 'googlegemini', name: 'Google Gemini', keywords: 'google gemini ai' },
  { slug: 'perplexity', name: 'Perplexity', keywords: 'perplexity ai search' },
  { slug: 'huggingface', name: 'Hugging Face', keywords: 'huggingface ai machine-learning models' },
  { slug: 'mistralai', name: 'Mistral AI', keywords: 'mistral ai llm' },
  { slug: 'cursor', name: 'Cursor', keywords: 'cursor ai code editor' },
  { slug: 'langchain', name: 'LangChain', keywords: 'langchain ai llm framework' },
  { slug: 'deepseek', name: 'DeepSeek', keywords: 'deepseek ai llm' },
  { slug: 'dropbox', name: 'Dropbox', keywords: 'dropbox storage files' },
  { slug: 'box', name: 'Box', keywords: 'box storage files enterprise' },
  { slug: 'calendly', name: 'Calendly', keywords: 'calendly scheduling booking' },
  { slug: 'intercom', name: 'Intercom', keywords: 'intercom support chat customer' },
  { slug: 'zendesk', name: 'Zendesk', keywords: 'zendesk support helpdesk customer' },
  { slug: 'mixpanel', name: 'Mixpanel', keywords: 'mixpanel analytics product' },
  { slug: 'greenhouse', name: 'Greenhouse', keywords: 'greenhouse recruiting hiring ats' },
  { slug: 'gusto', name: 'Gusto', keywords: 'gusto payroll hr' },
  { slug: 'zoho', name: 'Zoho', keywords: 'zoho crm suite business' },
  { slug: 'basecamp', name: 'Basecamp', keywords: 'basecamp project-management tasks' },
  { slug: 'todoist', name: 'Todoist', keywords: 'todoist tasks todo' },
  { slug: 'clockify', name: 'Clockify', keywords: 'clockify time-tracking' },
  { slug: 'toggl', name: 'Toggl', keywords: 'toggl time-tracking' },
  { slug: '1password', name: '1Password', keywords: 'password manager security' },
  { slug: 'twitch', name: 'Twitch', keywords: 'twitch streaming video live' },
  { slug: 'spotify', name: 'Spotify', keywords: 'spotify music audio' },
  { slug: 'medium', name: 'Medium', keywords: 'medium blog publishing writing' },
  { slug: 'producthunt', name: 'Product Hunt', keywords: 'product hunt launch community' },
  { slug: 'storyfunnels', name: 'StoryFunnels', keywords: 'storyfunnels storyos podcast marketing' },
  { slug: 'storypages', name: 'StoryPages', keywords: 'storypages storyos landing pages ai' },
];

export const BRAND_SLUGS: Set<string> = new Set(BRAND_ICON_META.map((d) => d.slug));

/** Stored-value convention for brand marks: `brand:<slug>` — parallel to
 * `set:<name>` above, e.g. "brand:github". */
export const BRAND_ICON_PREFIX = 'brand:';

/** Extract the brand slug from a stored icon value, or null if it's not a
 * (recognized) brand ref. */
export function brandIconSlug(value?: string | null): string | null {
  if (!value || !value.startsWith(BRAND_ICON_PREFIX)) return null;
  const slug = value.slice(BRAND_ICON_PREFIX.length);
  return BRAND_SLUGS.has(slug) ? slug : null;
}

/** True for any `brand:<slug>` ref, recognized or not. */
export function isBrandIconRef(value?: string | null): boolean {
  return Boolean(value && value.startsWith(BRAND_ICON_PREFIX));
}

/**
 * True when `value` contains emoji-shaped content: pictographic characters,
 * ZWJ sequences, variation selectors, or keycap combiners. Used to (a) detect
 * legacy emoji during the migration backfill and (b) power the "zero emoji
 * remain" post-migration scan (#251). A `set:` ref is never emoji-shaped.
 */
// Each of these codepoints (ZWJ, variation selector, keycap combiner) is
// matched independently as its own emoji-ish signal, not as a specific
// combined grapheme sequence \u2014 the lint below doesn't know that's intentional.
// eslint-disable-next-line no-misleading-character-class
const EMOJI_SHAPE_RE = /[\p{Extended_Pictographic}\u200d\ufe0f\u20e3]/u;
export function isEmojiShaped(value?: string | null): boolean {
  if (!value || isSetIconRef(value) || isBrandIconRef(value)) return false;
  return EMOJI_SHAPE_RE.test(value);
}

/** The fixed background-colour palette (MN-044) — kept as a plain union here
 * (not the zod enum in databases.ts/workspaces.ts) so this module stays
 * zod-free for the MCP bundle. */
export type IconColorToken =
  | 'gray' | 'brown' | 'gold' | 'orange' | 'red' | 'pink' | 'purple' | 'blue' | 'teal' | 'green';

const CATEGORY_COLOR: Record<IconCategory, IconColorToken> = {
  work: 'blue',
  tasks: 'purple',
  people: 'teal',
  content: 'brown',
  data: 'gray',
  comms: 'pink',
  objects: 'orange',
  nature: 'green',
  status: 'gold',
};

/** The icon-set name used when nothing else matches — a neutral "generic
 * record" glyph, consistent with the hardcoded `<Database>` fallback the
 * sidebar has always shown for icon-less rows. */
export const DEFAULT_ICON_NAME = 'database';

function colorForIconName(name: string): IconColorToken {
  const meta = ICON_SET_META.find((d) => d.name === name);
  return meta ? CATEGORY_COLOR[meta.categories[0]!] : 'gray';
}

/**
 * Name-inferred icon default (#251 AC): when a legacy emoji can't be resolved
 * through EMOJI_ICON_MIGRATION, fall back to matching the *entity's name*
 * against the icon-set keywords — e.g. "Clients" → the `handshake` icon
 * (people category) because "client" is in its keyword list. Falls back to
 * DEFAULT_ICON_NAME when no word matches anything.
 */
export function inferIconFromName(name: string): string {
  const words = (name || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));

  for (const w of words) {
    const hit = ICON_SET_META.find((d) => d.keywords.split(' ').includes(w));
    if (hit) return `${ICON_SET_PREFIX}${hit.name}`;
  }
  for (const w of words) {
    if (w.length < 3) continue;
    const hit = ICON_SET_META.find((d) => d.keywords.includes(w));
    if (hit) return `${ICON_SET_PREFIX}${hit.name}`;
  }
  return `${ICON_SET_PREFIX}${DEFAULT_ICON_NAME}`;
}

/** Background color for a name-inferred icon (used only when the entity has
 * no color set yet) — the same category→color mapping the migration table
 * uses, so inferred icons look consistent with mapped ones. */
export function inferColorForName(name: string): IconColorToken {
  return colorForIconName(setIconName(inferIconFromName(name))!);
}

export interface EmojiMigrationEntry {
  icon: string;
  color: IconColorToken;
}

/**
 * Emoji → curated-icon migration table (#251 backfill, expanded #283).
 * Ground truth for "emoji actually plausible in use": every emoji used by a
 * seed template pack default (apps/api/src/templates/definitions/*.ts), every
 * emoji offered by the pre-#251 icon picker's emoji tab (apps/web/src/
 * components/ui/icon-picker.tsx, EMOJI const — removed from the picker by
 * #251 but kept here as the migration's input vocabulary), every emoji
 * hardcoded as an integration/agent default (apps/api/src/integrations/
 * linear.service.ts, github.service.ts, apps/api/src/agents/agents.service.ts),
 * plus (#283) a broad general set of common emoji so an entity whose name
 * doesn't keyword-match anything still lands on a relevant icon instead of
 * inferIconFromName()'s generic `set:database` fallback. General-set entries
 * are added only where an existing curated icon is a genuinely reasonable
 * match — emoji with no decent fit (most animals, food, faces) are
 * deliberately left unmapped so they fall through to the name-inference
 * fallback rather than being forced onto a misleading icon.
 *
 * [emoji, icon-set name, optional color override] — color defaults to the
 * icon's category color (see colorForIconName) unless overridden here for a
 * clearer match (e.g. money icons get 'gold', not the category default).
 */
const MIGRATION_RULES: Array<[string, string, IconColorToken?]> = [
  // Work / planning
  ['📌', 'pin'],
  ['📋', 'list-checks'],
  ['✅', 'square-check'],
  ['📝', 'file-text'],
  ['📅', 'calendar-days'],
  ['📊', 'chart-bar'],
  ['📈', 'trending-up'],
  ['🗂️', 'files'],
  ['📁', 'files'],
  ['🗃️', 'archive'],
  ['💼', 'briefcase'],
  ['🧭', 'compass'],
  ['🎯', 'target'],
  ['🚀', 'rocket'],
  ['⚡', 'zap'],
  ['🔥', 'flame', 'red'],
  ['⭐', 'star'],
  ['💡', 'sparkles'],
  ['🔔', 'bell'],
  ['🏆', 'trophy'],
  ['🧱', 'layers'],
  ['🏃', 'timer'],
  ['🗓️', 'calendar-clock'],
  ['👣', 'milestone'],
  ['🎪', 'flag'],
  // People & comms
  ['🤝', 'handshake'],
  ['👥', 'users'],
  ['👤', 'user'],
  ['🗣️', 'mic'],
  ['💬', 'message-square'],
  ['📣', 'megaphone'],
  ['📢', 'megaphone'],
  ['✉️', 'mail'],
  ['📞', 'phone'],
  ['🎓', 'book-open'],
  ['🧑‍💻', 'wrench'],
  ['🫶', 'heart'],
  // Objects
  ['📦', 'package'],
  ['🔧', 'wrench'],
  ['⚙️', 'settings'],
  ['🔗', 'link'],
  ['🔑', 'key'],
  ['🔒', 'lock'],
  ['🧲', 'user-plus'],
  ['🧪', 'flask-conical'],
  ['🐛', 'bug'],
  ['🛠️', 'hammer'],
  ['💰', 'dollar-sign', 'gold'],
  ['💳', 'credit-card', 'gold'],
  ['🧾', 'receipt', 'gold'],
  ['🖼️', 'image'],
  ['🎨', 'palette'],
  ['📷', 'camera'],
  ['🎬', 'clapperboard'],
  ['🎥', 'film'],
  ['🎙️', 'mic'],
  ['📚', 'book-open'],
  ['📖', 'book'],
  ['📰', 'newspaper'],
  ['🗞️', 'newspaper'],
  ['✏️', 'pencil'],
  ['🖋️', 'pen-tool'],
  // Nature & misc
  ['🌱', 'sprout'],
  ['🌿', 'leaf'],
  ['☀️', 'sun'],
  ['🌙', 'moon'],
  ['🌊', 'waves'],
  ['🍀', 'leaf'],
  ['🐝', 'bird'],
  ['🦄', 'sparkles'],
  ['☕', 'coffee'],
  ['🍕', 'gift'],
  ['🧊', 'circle-dashed'],
  ['✈️', 'plane'],
  ['🗺️', 'map'],
  ['🏠', 'home'],
  ['🏢', 'building2'],
  ['⏰', 'alarm-clock'],
  ['⏳', 'hourglass'],
  ['♻️', 'repeat'],
  ['❤️', 'heart'],
  ['🟢', 'circle-dot', 'green'],
  ['🟡', 'pause', 'gold'],
  ['🔴', 'circle-x', 'red'],
  ['🧠', 'book-open'],
  ['👁️', 'eye'],
  ['🪄', 'wand'],
  ['🎁', 'gift'],
  ['🥇', 'trophy', 'gold'],
  ['🌴', 'sun'],
  // Integration / agent defaults not covered above (github.service.ts,
  // linear.service.ts, agents.service.ts)
  ['🐙', 'plug'],
  ['🔀', 'repeat'],
  ['🏷️', 'tag'],
  ['📐', 'compass'],
  ['🤖', 'zap'],
  ['▶️', 'activity'],

  // --- General set (#283) — common emoji beyond templates/integrations ---

  // Status & symbols
  ['❌', 'circle-x', 'red'],
  ['❓', 'circle-alert'],
  ['❗', 'triangle-alert'],
  ['‼️', 'triangle-alert', 'red'],
  ['✔️', 'circle-check'],
  ['☑️', 'square-check'],
  ['✳️', 'sparkles'],
  ['💯', 'trophy', 'gold'],
  ['🆗', 'circle-check', 'green'],
  ['🆕', 'sparkles', 'green'],
  ['⏸️', 'pause'],
  ['⏹️', 'circle-dot'],
  ['⏺️', 'circle-dot', 'red'],
  ['🔁', 'repeat'],
  ['🔂', 'repeat'],
  ['🚫', 'ban'],
  ['⛔', 'ban', 'red'],
  ['🚨', 'triangle-alert', 'red'],
  ['⚠️', 'triangle-alert', 'gold'],
  ['✖️', 'circle-x'],
  ['🔘', 'circle-dot'],
  ['⚪', 'circle'],
  ['⚫', 'circle'],
  ['🔵', 'circle-dot', 'blue'],
  ['🟣', 'circle-dot', 'purple'],
  ['🟠', 'circle-dot', 'orange'],
  ['🟤', 'circle-dot', 'brown'],
  ['⬜', 'circle'],
  ['⬛', 'circle'],

  // Tech & devices
  ['📱', 'phone'],
  ['💻', 'wrench'],
  ['🖥️', 'wrench'],
  ['⌨️', 'wrench'],
  ['🖱️', 'wrench'],
  ['🖨️', 'file-text'],
  ['💾', 'archive'],
  ['💿', 'archive'],
  ['📀', 'archive'],
  ['🔌', 'plug'],
  ['🔋', 'zap'],
  ['📡', 'globe'],
  ['🔍', 'eye'],
  ['🔎', 'eye'],
  ['🕵️', 'eye'],

  // Mail & comms
  ['📧', 'mail'],
  ['📨', 'send'],
  ['📩', 'send'],
  ['📤', 'send'],
  ['📥', 'mail'],
  ['📮', 'mail'],
  ['📬', 'mail'],
  ['📭', 'mail'],
  ['📪', 'mail'],
  ['📫', 'mail'],
  ['📇', 'contact'],
  ['☎️', 'phone'],
  ['📟', 'phone'],
  ['📠', 'send'],
  ['🔊', 'megaphone'],
  ['🔉', 'megaphone'],
  ['🔈', 'megaphone'],
  ['📯', 'megaphone'],
  ['🎵', 'music'],
  ['🎶', 'music'],

  // Finance
  ['💵', 'dollar-sign', 'gold'],
  ['💶', 'dollar-sign', 'gold'],
  ['💷', 'dollar-sign', 'gold'],
  ['💴', 'dollar-sign', 'gold'],
  ['🪙', 'coins', 'gold'],
  ['📉', 'chart-line', 'red'],
  ['🧮', 'table2'],
  ['💹', 'trending-up', 'gold'],

  // Weather & nature
  ['⛅', 'cloud'],
  ['🌤️', 'sun'],
  ['🌦️', 'cloud'],
  ['🌧️', 'droplet'],
  ['⛈️', 'cloud'],
  ['🌩️', 'zap'],
  ['🌨️', 'snowflake'],
  ['❄️', 'snowflake'],
  ['🌪️', 'waves'],
  ['🌫️', 'cloud'],
  ['🌈', 'palette'],
  ['☂️', 'droplet'],
  ['☔', 'droplet'],
  ['💧', 'droplet'],
  ['🌡️', 'activity'],

  // Documents
  ['🗒️', 'notebook-pen'],
  ['📄', 'file-text'],
  ['📃', 'file-text'],
  ['📑', 'files'],
  ['📜', 'file-text'],
  ['📔', 'notebook'],
  ['📓', 'notebook'],
  ['📒', 'notebook'],
  ['📕', 'book'],
  ['📗', 'book', 'green'],
  ['📘', 'book', 'blue'],
  ['📙', 'book', 'orange'],
  ['🔖', 'bookmark'],
  ['📛', 'tag'],
  ['🪪', 'contact'],

  // Celebration & reward
  ['🎉', 'gift'],
  ['🎊', 'gift'],
  ['🥳', 'gift'],
  ['👏', 'thumbs-up'],
  ['🙌', 'thumbs-up'],
  ['🏅', 'trophy', 'gold'],
  ['🎖️', 'trophy', 'gold'],
  ['🥈', 'trophy'],
  ['🥉', 'trophy', 'gold'],

  // Security
  ['🛡️', 'shield-check'],
  ['🔐', 'lock'],
  ['🔏', 'lock'],

  // People & work
  ['👩‍💻', 'wrench'],
  ['👨‍💻', 'wrench'],
  ['🧑‍🎨', 'palette'],
  ['🧑‍🔬', 'flask-conical'],
  ['🧑‍🏫', 'book-open'],
  ['🧑‍🚀', 'rocket'],
  ['🕴️', 'briefcase'],
];

export const EMOJI_ICON_MIGRATION: Record<string, EmojiMigrationEntry> = Object.fromEntries(
  MIGRATION_RULES.map(([emoji, iconName, colorOverride]) => {
    if (!ICON_NAMES.has(iconName)) {
      throw new Error(`EMOJI_ICON_MIGRATION: "${iconName}" is not in ICON_SET_META (typo?).`);
    }
    return [emoji, { icon: `${ICON_SET_PREFIX}${iconName}`, color: colorOverride ?? colorForIconName(iconName) }];
  }),
);

/**
 * Resolve the migrated {icon, color} for a legacy stored icon value. Returns
 * the mapped SVG ref/color when the emoji is a known migration entry, the
 * name-inferred default when it's emoji-shaped but unmapped, or null when
 * `value` isn't emoji-shaped at all (already a `set:` ref, or empty/unset —
 * nothing to migrate).
 */
export function resolveMigratedIcon(
  value: string | null | undefined,
  entityName: string,
): { icon: string; color: IconColorToken } | null {
  if (!isEmojiShaped(value)) return null;
  const mapped = EMOJI_ICON_MIGRATION[value!];
  if (mapped) return mapped;
  return { icon: inferIconFromName(entityName), color: inferColorForName(entityName) };
}

/**
 * Normalize an incoming icon value at write time (#283): close the raw-emoji
 * write path by running every icon write through the same table the one-time
 * backfill (#251) uses, instead of trusting callers to only ever send a
 * `set:` ref. Pass through `null`/`undefined` (no icon supplied) and anything
 * that isn't emoji-shaped (already a `set:` ref, or plain text) unchanged;
 * resolve legacy emoji to a curated icon via {@link resolveMigratedIcon}.
 *
 * This is deliberately a *value* helper, not a zod `.transform()`, because
 * the emoji-shaped fallback needs the entity's name for
 * {@link inferIconFromName} — for updates that don't also change the name,
 * only the caller (the service, which already has the current row loaded)
 * knows it. Call this from every icon-accepting service method (spaces,
 * databases, space_folders, space_documents), not just the HTTP-facing zod
 * schemas — templates and integrations (linear.service.ts, github.service.ts,
 * agents.service.ts) construct entities through those same services without
 * going through a Nest DTO, so schema-only validation would miss them.
 */
export function normalizeIconInput(
  icon: string | null | undefined,
  entityName: string,
): string | null | undefined {
  if (icon === null || icon === undefined) return icon;
  const resolved = resolveMigratedIcon(icon, entityName);
  return resolved ? resolved.icon : icon;
}
