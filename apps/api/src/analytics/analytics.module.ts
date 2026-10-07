import { Global, Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

/** Global: any service may emit an event without a module edge, as NotificationsService does. */
@Global()
@Module({ providers: [AnalyticsService], exports: [AnalyticsService] })
export class AnalyticsModule {}
