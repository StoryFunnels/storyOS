import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * #1104 — a record create/update by a gated agent was NOT performed: it is staged as an approval and waits for a person.
 *
 * Thrown (not returned) because create/update have a dozen internal callers whose return type is a record; a union would
 * have rippled through all of them. Answered over HTTP as 202 with `{ pending_approval: true, approval_id, message }`: the
 * same flag the delete gate (#542) answers with, so a client that already reads it needs nothing new. 202, not 200,
 * because nothing was written yet. AllExceptionsFilter has the one branch that keeps the body (an HttpException's body
 * would otherwise be reshaped into the error envelope and lose the approval id).
 */
export class WriteHeldForApprovalException extends HttpException {
  constructor(
    readonly approvalId: string,
    readonly detail: string,
  ) {
    super(
      { pending_approval: true, approval_id: approvalId, message: detail },
      HttpStatus.ACCEPTED,
    );
  }
}
