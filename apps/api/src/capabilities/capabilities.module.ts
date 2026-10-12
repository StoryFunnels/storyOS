import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { CapabilitiesController } from './capabilities.controller';

@Module({
  imports: [DocumentsModule],
  controllers: [CapabilitiesController],
})
export class CapabilitiesModule {}
