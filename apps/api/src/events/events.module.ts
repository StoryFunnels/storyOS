import { Global, Module } from '@nestjs/common';
import { DomainEventsService } from './domain-events.service';

@Global()
@Module({ providers: [DomainEventsService], exports: [DomainEventsService] })
export class EventsModule {}
