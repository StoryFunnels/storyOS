import { Module } from '@nestjs/common';
import { ValidationEnforcer } from './validation-enforcer';

/** Imported by RecordsModule so the write path can enforce; has no dependency on the records layer. */
@Module({ providers: [ValidationEnforcer], exports: [ValidationEnforcer] })
export class ValidationEnforcerModule {}
