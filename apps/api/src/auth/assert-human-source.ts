import { ForbiddenException } from '@nestjs/common';
import type { AuthedRequest } from './auth.guard';

/**
 * #859 — an approval is a person's decision. `source` is derived at the auth boundary (a browser
 * session is `human`; a token or an OAuth-connected AI is not, per #858) and cannot be claimed by
 * the caller, so it is the one thing an agent holding an admin's credentials cannot satisfy.
 * Role and "named approver" still decide WHO among people; this decides that it is a person.
 *
 * The human path that must keep working is the web Inbox (a session). MCP deliberately exposes no
 * approve/reject tool, so refusing `mcp` here strands nothing.
 */
export function assertHumanSource(req: AuthedRequest): void {
  if ((req.auth?.source ?? 'human') === 'human') return;
  throw new ForbiddenException(
    'Approving or rejecting needs a person: it cannot be done through an API token or a connected AI, even one acting for an admin. Open the Inbox in StoryOS and decide there.',
  );
}
