# Source providers

A source provider is a `SourceProviderDescriptor` (`types.ts`) registered in
`index.ts`'s `SOURCE_PROVIDER_REGISTRY` map. Adding one is a new file here
plus one entry in that map — never a schema change (`sources.providerSource`
is free text; see `sources.service.ts`'s header comment).

## The Engagement shape (MN-261)

`meta.page_comments`, `x.mentions`, and `linkedin.org_engagement`
(`meta_engagement.ts`, `x_engagement.ts`, `linkedin_engagement.ts`) all emit
the same normalized shape, defined once in `engagement.ts` as
`EngagementItem`:

| key | meaning |
| --- | --- |
| `provider` | the emitting source's registry id, e.g. `"meta.page_comments"` |
| `kind` | `'comment' \| 'mention' \| 'reply'` |
| `external_id` | the upsert key — provider-native id (comment id / tweet id) |
| `author_handle` | stable handle if the platform exposes one, else `null` |
| `author_name` | display name if available, else `null` |
| `text` | body text (`""`, never `null`, when there is none) |
| `permalink` | link to the item if the API returns one, else `null` |
| `parent_external_id` | the comment/tweet this replies to, else `null` |
| `post_external_id` | the top-level post/tweet/share this hangs off, else `null` |
| `posted_at` | ISO 8601, else `null` |

Because all three agree on this shape, one **Engagement** database's
field-mapping can point every provider's `external_id` at the same field —
one board, three sources. `engagement.ts`'s `assertEngagementShape()` is the
shared conformance check every provider's test suite runs against
(`engagement.test.ts`'s parametrized fixture).

## What's simulated vs. what's real (read before connecting anything)

The ticket this shipped from (`MN-261`) assumed a dedicated Meta OAuth
connection (`MN-258`) already existed. It doesn't — verified against
`connections/providers/index.ts` before writing these three files. All three
providers therefore declare `connectionProvider: 'http'` and run against the
generic bearer-token connection (`connections/providers/http.ts`, MN-263):
paste in a token you minted yourself via each platform's own developer
console (a Meta Page Access Token, an X OAuth2 user token, a LinkedIn org
access token). A real per-platform OAuth connection is a clean follow-up —
swapping `connectionProvider` to `'meta'` / `'x'` / `'linkedin'` is the only
change each provider file would need once that connection exists.

Per-provider caveats to surface in any connect UI copy:

- **Meta** (`meta.page_comments`) — the best-behaved of the three. One
  source = one Page's token; add `ig_user_id` to also pull the paired
  Instagram Business Account's comments. Reply nesting (`parent`) is only
  reported for Facebook Page comments, not Instagram's flat comments edge.
- **X** (`x.mentions`) — tier-limited: how far back mentions go and how many
  you get back depends entirely on the connected account's own X API plan.
  This provider doesn't and can't work around that.
- **LinkedIn** (`linkedin.org_engagement`) — the weakest API of the three,
  and shipped **last**. `r_organization_social` is a restricted-review
  LinkedIn Partner Program scope; the provider is registered (config
  validates, tests run against mocked fetchers) but `sync()` refuses to call
  out — throwing a visible `sourceRuns` error — until an operator has
  actually cleared LinkedIn's app review and set `LINKEDIN_ACTIONS_ENABLED=true`
  (`config/env.ts`). It also can't discover an org's recent posts on its
  own — `post_urns` is an explicit config list, not auto-discovered. It never
  reports a handle, a display name, or a permalink (LinkedIn's
  `socialActions/.../comments` endpoint gives none of those).

None of the three ever fetch DMs.

## The "Engagement triage" view (Step 4 — docs, not engine code)

No new engine code backs this — it's a saved-view recipe on top of whatever
database a `meta.page_comments` / `x.mentions` / `linkedin.org_engagement`
source targets:

1. Add a **single-select** field, `Reply status`, with options `New` →
   `Needs reply` → `Drafted` → `Approved` → `Posted` (in that order).
2. Add a board view grouped by `Reply status`. New rows a source upserts
   land with whatever default the field's config gives new records — set
   that default to `New` (see the field-defaults dialog).
3. Optionally add a `Reply draft` rich-text field for an agent (or a human)
   to stage a reply before it's approved.

Example agent prompt for the triage loop (run manually via MCP, or as a
scheduled `run_agent` automation once `reply_social` — MN-261 Phase 2, not
yet built — lands):

> Query the Engagement database for records where `Reply status` = "Needs
> reply". For each, read `text` and `permalink`, draft a short, on-brand
> reply in `Reply draft`, and set `Reply status` to "Drafted". Never post
> anything yourself — a human approves before it goes out.

## Follow-ups this ticket deliberately left open

- **`reply_social` action** (Phase 2 in the ticket): posts an approved reply
  back to Meta/X/LinkedIn. Explicitly gated behind sources running stable in
  dogfood for a week first — not started here. When it is: `validate()`
  (`automations/actions.service.ts`) must hard-reject any attempt to set
  `require_approval: false` on this action kind with a 422, no admin
  override — brand replies always need a human in the loop.
- **A dedicated Meta/X/LinkedIn OAuth connection provider** — today's `http`
  bearer workaround (above) is a deliberate simplification, not the intended
  end state.
