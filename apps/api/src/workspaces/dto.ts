import { createZodDto } from 'nestjs-zod';
import {
  acceptInviteSchema,
  createInviteSchema,
  createSpaceSchema,
  createWorkspaceSchema,
  updateMemberSchema,
  updateSpaceSchema,
  updateWorkspaceSchema,
} from '@storyos/schemas';

export class CreateWorkspaceDto extends createZodDto(createWorkspaceSchema) {}
export class UpdateWorkspaceDto extends createZodDto(updateWorkspaceSchema) {}
export class CreateSpaceDto extends createZodDto(createSpaceSchema) {}
export class UpdateSpaceDto extends createZodDto(updateSpaceSchema) {}
export class CreateInviteDto extends createZodDto(createInviteSchema) {}
export class AcceptInviteDto extends createZodDto(acceptInviteSchema) {}
export class UpdateMemberDto extends createZodDto(updateMemberSchema) {}
