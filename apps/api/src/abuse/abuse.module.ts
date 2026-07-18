import { Module } from '@nestjs/common';
import { AbuseFlagsService } from './abuse-flags.service';

/**
 * MN-195 — deliberately dependency-free beyond DB (@Global()): RecordsModule
 * is imported by nearly every other module in the app, so anything it
 * imports has an outsized cycle-risk surface. No cycle here — nothing else
 * in this module needs anything outside itself.
 */
@Module({
  providers: [AbuseFlagsService],
  exports: [AbuseFlagsService],
})
export class AbuseModule {}
