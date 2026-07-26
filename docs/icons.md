# Icons

Databases and spaces carry an **icon** and an optional **background colour**.
The `icon` value is a **curated icon** referenced as `set:<name>` (e.g.
`set:database`) — a crisp line-icon set that renders identically on every
platform (MN-208).

Emoji icons were retired as of #251: every database/space that held an emoji
was backfilled to the nearest curated icon (`apps/api/src/icons/migrate-
emoji-icons.ts`), and the in-app picker no longer offers emoji at all. The
renderer (`EntityIcon` in `apps/web/src/components/ui/icon-picker.tsx`) still
tolerates a raw emoji string if one ever arrives again — e.g. from an older
MCP client that hasn't updated — rendering it as-is rather than blanking the
tile, but nothing in the product writes one anymore.

Set an icon over the API or MCP by writing the `icon` field on a database or
space, e.g. `{ "icon": "set:rocket", "color": "purple" }`. Colours are the fixed
palette: gray, brown, gold, orange, red, pink, purple, blue, teal, green. The
MCP's `list_icon_set` tool returns the full catalog, grouped by category, so
an agent can pick a real name rather than guessing.

In the app, use the icon picker (sidebar → a database/space → **Icon & color**,
or click the icon directly in a database's header): search, browse by
category, choose a background, and preview live. The change applies
immediately and shows in both the header and the sidebar.

## Brand icons (`brand:<slug>`)

Alongside the curated `set:` icons, a second namespace covers real, recognizable
platform logos — for cases like "this is our LinkedIn workspace" or "this
connects to Notion" that a generic glyph can't express (#298). Written the
same way, e.g. `{ "icon": "brand:github", "color": "purple" }`. Brand marks
are rendered as monochrome masks so the selected palette colour tints the logo
and its soft background consistently with `set:` icons (#335). With no colour
selected, the logo inherits the surrounding neutral text colour.

The set is ~100 third-party marks sourced from [Simple Icons](https://simpleicons.org/)
(CC0-licensed), curated for a work-OS / marketing-agency audience — social,
dev/eng, productivity, business/marketing, web/CMS, infra/AI, and CRM/ops
tooling — plus two hand-recreated marks for StoryOS's own sibling products,
`storyfunnels` and `storypages`. The SVGs are vendored one file per icon under
`apps/web/public/brand-icons/<slug>.svg`. In the picker, the **Brands** chip
browses the full set, and the same search box matches a brand's slug or
keywords (e.g. `x-twitter` is findable by both "x" and "twitter").

A handful of well-known marks (LinkedIn, Slack, Microsoft's and Adobe's
product suites, AWS, Salesforce) aren't included — Simple Icons no longer
ships them (brand-requested removals) — and were substituted with other real,
CC0-licensed marks in the same category rather than hand-drawn from scratch.

## Available `set:` names

**Work** — `briefcase`, `folder-kanban`, `layout-dashboard`, `target`, `rocket`, `flag`, `milestone`, `trophy`, `compass`, `map`, `building2`, `goal`

**Tasks & time** — `square-check`, `check-square`, `list-todo`, `list-checks`, `clock`, `calendar-days`, `calendar-clock`, `alarm-clock`, `hourglass`, `timer`, `repeat`, `circle-dashed`

**People** — `users`, `user`, `user-round`, `users-round`, `contact`, `handshake`, `user-plus`, `crown`, `baby`

**Content & media** — `file-text`, `files`, `notebook`, `notebook-pen`, `book-open`, `book`, `newspaper`, `pen-tool`, `pencil`, `feather`, `image`, `camera`, `film`, `clapperboard`, `mic`, `music`, `palette`, `brush`

**Data & analytics** — `database`, `table`, `table2`, `chart-bar`, `chart-line`, `chart-pie`, `trending-up`, `activity`, `boxes`, `package`, `archive`, `layers`, `grid3x3`, `filter`

**Communication** — `message-square`, `message-circle`, `mail`, `send`, `bell`, `megaphone`, `phone`, `at-sign`, `hash`

**Objects & tools** — `wrench`, `settings`, `cog`, `hammer`, `bug`, `flask-conical`, `test-tube`, `link`, `key`, `lock`, `shield-check`, `zap`, `plug`, `puzzle`, `wand`, `sparkles`, `gift`, `shopping-cart`, `credit-card`, `receipt`, `dollar-sign`, `wallet`, `coins`, `tag`, `tags`, `bookmark`, `paperclip`, `pin`, `star`, `heart`

**Nature & places** — `sprout`, `leaf`, `tree-pine`, `flower2`, `sun`, `moon`, `cloud`, `waves`, `flame`, `droplet`, `mountain`, `snowflake`, `bird`, `home`, `plane`, `globe`, `map-pin`, `coffee`

**Status** — `circle-check`, `circle-alert`, `circle-x`, `circle-dot`, `circle`, `triangle-alert`, `ban`, `eye`, `eye-off`, `thumbs-up`, `loader`, `pause`

_The name/category/keyword data is curated in `packages/schemas/src/icons.ts`
(the source of truth, shared by the web app, the migration backfill, and the
MCP); `apps/web/src/components/ui/icon-set.tsx` pairs each name with its
lucide-react component. This list is a snapshot — `list_icon_set` (MCP) is
always current, and now also returns the `brand:` catalog under its `brands`
key._
