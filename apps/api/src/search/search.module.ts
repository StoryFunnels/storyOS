import { Module } from '@nestjs/common';
import { RecordsModule } from '../records/records.module';
import { SearchController } from './search.controller';
import { MyWorkService } from './my-work.service';

@Module({ imports: [RecordsModule], controllers: [SearchController], providers: [MyWorkService], exports: [MyWorkService] })
export class SearchModule {}
