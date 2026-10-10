import { Injectable, OnModuleInit } from '@nestjs/common';
import type { ChangeSource } from '../db/schema';
import { SkillsService } from '../skills/skills.service';
import type { PublicPublishGate } from '../skills/skills.service';
import { ApprovalsService } from './approvals.service';
import type { ApprovalActionSnapshot, SkillPublishPublicSnapshot } from './approvals.service';
import { JobRunnerService } from './job-runner.service';

/**
 * #867 AC3 — the producer and executor for "make this skill PUBLIC", the one tier an AI may only
 * PROPOSE. A public skill is an unauthenticated link, so the person decides, per action:
 *
 *  - an AI asks (over MCP or the API) -> `propose` parks an `approvals` row, the skill stays as it
 *    was, and the token's OWNER is notified and named the approver;
 *  - a PERSON approves in the app's Inbox. Approval is human-sourced only (#859, PR #1008), so the
 *    credential that proposed it cannot approve it, even an admin's;
 *  - only then does the executor below apply it (`SkillsService.applyApprovedPublic`).
 *
 * Registered here, not in SkillsModule, because approvals live in AutomationsModule and
 * SkillsModule is deliberately standalone: AutomationsModule imports SkillsModule one way and
 * hands the service its gate at boot. If this never registers, a non-human `public` request is a
 * plain 403, the state before #867 (AC10: it must never be an allow without the approval).
 */
@Injectable()
export class SkillPublishGateService implements OnModuleInit, PublicPublishGate {
  constructor(
    private readonly approvals: ApprovalsService,
    private readonly skills: SkillsService,
    private readonly jobs: JobRunnerService,
  ) {}

  onModuleInit(): void {
    this.skills.registerPublicGate(this);
    this.jobs.registerExecutor('skill_publish_public', async (payload) => {
      const { action, ctx } = payload as { action: SkillPublishPublicSnapshot; ctx: ApprovalActionSnapshot['ctx'] };
      await this.skills.applyApprovedPublic(ctx.workspaceId, action.skill_id);
    });
  }

  async propose(input: {
    workspaceId: string;
    skillId: string;
    skillName: string;
    ownerId: string;
    requesterSource: ChangeSource;
  }): Promise<{ approvalId: string }> {
    const row = await this.approvals.createRow({
      workspaceId: input.workspaceId,
      databaseId: null,
      ruleId: null,
      runId: null,
      recordId: null,
      actionIndex: 0,
      action: {
        type: 'skill_publish_public',
        skill_id: input.skillId,
        skill_name: input.skillName,
        requester_source: input.requesterSource,
      },
      previewText: `Make the skill "${input.skillName}" public: anyone with its link will be able to read it`,
      // The token's owner: the person whose AI is asking. They are named the approver.
      requesterActorId: input.ownerId,
    });
    return { approvalId: row.id };
  }
}
