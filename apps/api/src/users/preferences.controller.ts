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

const preferencesPatchSchema = z.object({
  notifications: notificationTogglesSchema.optional(),
  regional: regionalSchema.optional(),
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
