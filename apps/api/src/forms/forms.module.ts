import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { RecordsModule } from '../records/records.module';
import { FormsService } from './forms.service';
import { PublicFormsController } from './public-forms.controller';

/** Public (unauthenticated) form sharing + submission (MN-101). */
@Module({
  imports: [RecordsModule, BillingModule],
  controllers: [PublicFormsController],
  providers: [FormsService],
})
export class FormsModule {}
