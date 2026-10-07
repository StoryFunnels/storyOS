import { Module } from '@nestjs/common';
import { AttachmentsModule } from '../attachments/attachments.module';
import { BillingModule } from '../billing/billing.module';
import { PortalModule } from '../portal/portal.module';
import { RecordsModule } from '../records/records.module';
import { FormsService } from './forms.service';
import { PublicFormsController } from './public-forms.controller';

/** Public (unauthenticated) form sharing + submission (MN-101). */
@Module({
  // #538 — PortalModule for recipient resolution + the portal access log,
  // same imports ViewsModule already takes for PublicViewsService's identical need.
  // #710 — AttachmentsModule so a public form's file field reuses the exact
  // upload mechanism (size cap, storage, thumbnail) the authenticated path uses.
  imports: [RecordsModule, BillingModule, PortalModule, AttachmentsModule],
  controllers: [PublicFormsController],
  providers: [FormsService],
})
export class FormsModule {}
