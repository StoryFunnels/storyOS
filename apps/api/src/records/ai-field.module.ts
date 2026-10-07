import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { AiFieldSubscriber } from './ai-field.subscriber';

/**
 * #571 — AiFieldSubscriber needs only JobRunnerService (from
 * AutomationsModule) and DB/DomainEventsService, both @Global() — no
 * RecordsService dependency, so this is a standalone leaf module rather
 * than living inside RecordsModule, which would create exactly the cycle
 * SourcesModule's own comment names (RecordsModule -> AutomationsModule ->
 * ... -> RecordsModule). No forwardRef needed: nothing in AutomationsModule
 * imports this module back.
 */
@Module({
  imports: [AutomationsModule],
  providers: [AiFieldSubscriber],
})
export class AiFieldModule {}
