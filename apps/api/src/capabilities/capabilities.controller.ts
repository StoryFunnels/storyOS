import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { PdfRenderer } from '../documents/export/pdf-renderer';

/**
 * #885 — what THIS server can currently do, for capabilities that can be unavailable.
 *
 * The rule it exists to serve: a capability that can be unavailable must advertise its
 * availability, or every client discovers it by failing in front of a user. Today the
 * only entry is `pdf_export` (its sidecar is opt-in, and production has none until the
 * compose service exists); a new optional capability gets its entry here rather than a
 * route of its own.
 *
 * Each entry says what it MEANS by its names (see PdfExportStatus): `available` is
 * reachability checked against the thing itself, never merely "a variable is set".
 *
 * Authenticated, not public: it describes the deployment's infrastructure, and the only
 * consumer is a signed-in client deciding what to offer.
 */
@ApiTags('capabilities')
@ApiBearerAuth()
@Controller('capabilities')
@UseGuards(AuthGuard)
export class CapabilitiesController {
  constructor(private readonly pdf: PdfRenderer) {}

  @Get()
  @ApiOperation({
    summary:
      'What this server can currently do (#885). pdf_export.available = configured AND the renderer answered its health check within the last `checked_at` window — gate on that, not on `configured`.',
  })
  async get() {
    return { pdf_export: await this.pdf.status() };
  }
}
