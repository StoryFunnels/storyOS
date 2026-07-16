# Icons

Databases and spaces carry an **icon** and an optional **background colour**.
The `icon` value is one of:

- an **emoji** (e.g. `📊`), or
- a **curated icon** referenced as `set:<name>` (e.g. `set:database`) — a crisp
  line-icon set that renders identically on every platform (MN-208).

Set an icon over the API or MCP by writing the `icon` field on a database or
space, e.g. `{ "icon": "set:rocket", "color": "purple" }`. Colours are the fixed
palette: gray, brown, gold, orange, red, pink, purple, blue, teal, green.

In the app, use the icon picker (sidebar → a database/space → **Icon & color**):
search, browse by category, choose a background, and preview live. Existing
emoji icons keep working — nothing is migrated.

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

_The set is curated in `apps/web/src/components/ui/icon-set.tsx`, which is the source of truth; this list is a snapshot._
