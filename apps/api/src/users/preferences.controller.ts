import { Body, Controller, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthedRequest } from '../auth/auth.guard';
import { PreferencesService } from './preferences.service';

const notificationTogglesSchema = z
  .object({
    assigned: z.boolean(),
    mentioned: z.boolean(),
    commented: z.boolean(),
  })
  .partial();

const regionalSchema = z
  .object({
    dateFormat: z.enum(['system', 'MDY', 'DMY', 'YMD']),
    timeFormat: z.enum(['system', '12h', '24h']),
    firstDayOfWeek: z.enum(['system', 'sunday', 'monday', 'saturday']),
  })
  .partial();

const myWorkDbConfigSchema = z.object({
  group_by_field_id: z.string().optional(),
  color_by_field_id: z.string().optional(),
  hidden_field_ids: z.array(z.string()).optional(),
  filters: z
    .object({
      and: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown().optional() })),
    })
    .optional(),
});

const preferencesPatchSchema = z.object({
  notifications: notificationTogglesSchema.optional(),
  regional: regionalSchema.optional(),
  /** Per-database My Work config, keyed by database id (MN-072 part 2). */
  myWork: z.record(z.string(), myWorkDbConfigSchema).optional(),
});
class PreferencesPatchDto extends createZodDto(preferencesPatchSchema) {}

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
}
