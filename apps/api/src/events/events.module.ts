import { Global, Module } from '@nestjs/common';
import { DomainEventsService } from './domain-events.service';
import { MembershipEventsService } from './membership-events.service';

@Global()
@Module({
  providers: [DomainEventsService, MembershipEventsService],
  exports: [DomainEventsService, MembershipEventsService],
})
export class EventsModule {}
