import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { PREFERENCE_LISTS, PreferencesService } from './preferences.service';

const notificationTogglesSchema = z
  .object({
    assigned: z.boolean(),
    mentioned: z.boolean(),
    commented: z.boolean(),
    state_changed: z.boolean(),
    // #273 — email opt-out for a watched record's `record_changed` notification;
    // was already in UserPreferences/DEFAULT_PREFERENCES but never settable
    // through this endpoint, so the toggle silently no-opped (dropped by zod).
    record_changed: z.boolean(),
  })
  .partial();

const regionalSchema = z
  .object({
    dateFormat: z.enum(['system', 'MDY', 'DMY', 'YMD']),
    timeFormat: z.enum(['system', '12h', '24h']),
    firstDayOfWeek: z.enum(['system', 'sunday', 'monday', 'saturday']),
  })
  .partial();

// Mirrors packages/schemas' conditionSchema (MN-253 UI): field/op/value plus the
// non-destructive UI fields — My Work uses the same builder + config shape as views.
const myWorkConditionSchema = z.object({
  field: z.string(),
  op: z.string(),
  value: z.unknown().optional(),
  disabled: z.boolean().optional(),
  pinned: z.boolean().optional(),
  label: z.string().max(120).optional(),
  icon: z.string().max(40).optional(),
});

// MN-252: My Work uses the same sort spec shape as saved views (packages/schemas'
// sortSchema), applied client-side to the already-fetched rows (group-config.tsx
// sortMyWorkRecords) rather than at the DB layer.
const myWorkSortSchema = z.object({
  field: z.string(),
  direction: z.enum(['asc', 'desc']),
});

const myWorkDbConfigSchema = z.object({
  group_by_field_id: z.string().optional(),
  color_by_field_id: z.string().optional(),
  hidden_field_ids: z.array(z.string()).optional(),
  filters: z
    .union([
      z.object({ and: z.array(myWorkConditionSchema) }),
      z.object({ or: z.array(myWorkConditionSchema) }),
    ])
    .optional(),
  sorts: z.array(myWorkSortSchema).max(3).optional(),
  /** Whole-sort empty-values placement (MN-252); omitted = trailing, matching views. */
  sorts_nulls: z.enum(['first', 'last']).optional(),
});

// #43: the reviewer's own GitHub login, used to tell "needs my review" /
// "authored by me" / "participating" apart when querying GitHub search.
// Usernames are 1-39 chars, alphanumeric + single hyphens (GitHub's own rule);
// null clears it.
const githubPrefsSchema = z
  .object({
    login: z
      .string()
      .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/)
      .nullable(),
  })
  .partial();

// #155: which workspaces this user has dismissed the first-run activation
// checklist for. The client sends the full next list; capped to keep the blob
// bounded (a user is only ever in so many workspaces).
const activationSchema = z
  .object({
    dismissedWorkspaces: z.array(z.string()).max(1000),
  })
  .partial();

// #775: workspaces where this user has views-only mode on. Client sends the full
// next list (same contract as `activation`), capped to keep the blob bounded.
const sidebarSchema = z
  .object({
    viewsOnlyWorkspaces: z.array(z.string()).max(1000),
  })
  .partial();

const preferencesPatchSchema = z.object({
  notifications: notificationTogglesSchema.optional(),
  regional: regionalSchema.optional(),
  /** Per-database My Work config, keyed by database id (MN-072 part 2). */
  myWork: z.record(z.string(), myWorkDbConfigSchema).optional(),
  github: githubPrefsSchema.optional(),
  /** First-run activation checklist dismissal (#155). */
  activation: activationSchema.optional(),
  /** Sidebar display preferences (#775). */
  sidebar: sidebarSchema.optional(),
});
class PreferencesPatchDto extends createZodDto(preferencesPatchSchema) {}

// #987: add and remove items of a list-valued preference, applied atomically. An id is a workspace id; capped like the whole-list patch.
const listItems = z.array(z.string().min(1).max(100)).max(1000);
const preferenceListEditSchema = z
  .object({
    list: z.enum(Object.keys(PREFERENCE_LISTS) as [keyof typeof PREFERENCE_LISTS, ...Array<keyof typeof PREFERENCE_LISTS>]),
    add: listItems.optional(),
    remove: listItems.optional(),
  })
  .refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, { message: 'Give at least one item to add or remove' });
class PreferenceListEditDto extends createZodDto(preferenceListEditSchema) {}

/** Personal preferences (#30/#31): notification toggles now, regional formats next. */
@ApiTags('users')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('users/me/preferences')
export class PreferencesController {
  constructor(private readonly preferences: PreferencesService) {}

  @Get()
  @ApiOperation({ summary: 'My preferences (defaults applied)' })
  get(@Req() req: AuthedRequest) {
    return this.preferences.get(req.user.id);
  }

  @Patch()
  @ApiOperation({ summary: 'Update my preferences (deep-merged)' })
  update(@Req() req: AuthedRequest, @Body() body: PreferencesPatchDto) {
    return this.preferences.update(req.user.id, body);
  }

  @Patch('lists')
  @ApiOperation({
    summary:
      'Add and/or remove items of a list-valued preference (dismissed_workspaces, views_only_workspaces), atomically: two tabs adding different items never lose one',
  })
  editList(@Req() req: AuthedRequest, @Body() body: PreferenceListEditDto) {
    return this.preferences.editList(req.user.id, body.list, { add: body.add, remove: body.remove });
  }
}
