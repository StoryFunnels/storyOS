import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';

@Module({
  controllers: [UsersController, PreferencesController],
  providers: [PreferencesService],
  exports: [PreferencesService],
})
export class UsersModule {}
