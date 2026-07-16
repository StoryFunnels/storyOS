import { Module } from '@nestjs/common';
import { RecordsModule } from '../records/records.module';
import { SearchController } from './search.controller';

@Module({ imports: [RecordsModule], controllers: [SearchController] })
export class SearchModule {}
