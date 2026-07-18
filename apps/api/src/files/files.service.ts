import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { memberships, workspaceFiles, workspaces } from '../db/schema';
import { getStorage } from '../attachments/storage';
import { AUTH } from '../auth/auth.tokens';
import type { Auth } from '../auth/auth';
import { toWebHeaders } from '../auth/auth.guard';
import { TokensService } from '../tokens/tokens.service';
import { mintDownloadUrl, verifyDownloadSignature } from './signed-download';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — editor images, not bulk file storage

/** Workspace-scoped uploads for rich-text editors (MN-097). Stored via the same
 * storage driver as attachments.
 *
 * Two read paths, deliberately different (#201):
 *  - INLINE (`GET /files/:id`, capability URL): unauthenticated by default so an
 *    embedded `<img>` loads without cookies/CORS. If the workspace has turned on
 *    private-attachments mode, this path instead requires an authenticated,
 *    workspace-member request.
 *  - DOWNLOAD (`GET /files/:id/download`, signed URL): always requires a valid,
 *    unexpired, un-revoked signature. Minting one requires an authenticated
 *    request with access to the file's workspace — the mint step is the access
 *    check; the resulting URL carries its own proof after that.
 * Both paths refuse a revoked file outright. */
@Injectable()
export class FilesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly tokens: TokensService,
  ) {}

  async upload(workspaceId: string, input: { filename: string; mime: string; data: Buffer }, actorId: string) {
    if (!input.mime.startsWith('image/')) {
      throw new UnprocessableEntityException('Only images can be embedded in the editor.');
    }
    if (input.data.length > MAX_BYTES) {
      throw new UnprocessableEntityException(`Image too large (${input.data.length} bytes; limit ${MAX_BYTES}).`);
    }
    const key = `editor/${workspaceId}/${randomUUID()}`;
    await getStorage().put(key, input.data, input.mime);
    const [row] = await this.db
      .insert(workspaceFiles)
      .values({ workspaceId, filename: input.filename.slice(0, 255), mime: input.mime, size: input.data.length, storageKey: key, uploadedBy: actorId })
      .returning();
    return { id: row!.id, url: `/api/v1/files/${row!.id}` };
  }

  /**
   * Identity of the caller, if any — session cookie or PAT bearer, mirroring the
   * subset of AuthGuard's resolution that a conditionally-public route needs.
   * Not a second auth mechanism: same TokensService.resolve / auth.api.getSession
   * primitives AuthGuard itself uses, just invoked without throwing, because this
   * route serves anonymous requests whenever private-attachments mode is off.
   * Route-level concerns that only make sense inside a real guarded route
   * (PAT read/write scope enforcement, `@RequiresScope`) are intentionally not
   * replicated here — every PAT's default scope satisfies a read.
   */
  private async resolveRequestUser(
    request: FastifyRequest,
  ): Promise<{ userId: string; tokenWorkspaceId?: string } | null> {
    const header = request.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Bearer mn_pat_')) {
      const resolved = await this.tokens.resolve(header.slice('Bearer '.length));
      return resolved ? { userId: resolved.userId, tokenWorkspaceId: resolved.workspaceId } : null;
    }
    const session = await this.auth.api.getSession({ headers: toWebHeaders(request.headers) });
    return session ? { userId: (session.user as { id: string }).id } : null;
  }

  /** Active membership check — the same predicate WorkspaceAccessGuard uses
   * (default `minRole: 'guest'`, i.e. any active member). Files have no
   * per-record or per-space scope to check against (they're workspace-wide
   * editor embeds, not attached to a record), so "viewer+ on the owning
   * record/space" collapses to "an active member of the owning workspace" here
   * — the finest grain the data model actually supports. */
  private async isActiveMember(workspaceId: string, userId: string): Promise<boolean> {
    const membership = await this.db.query.memberships.findFirst({
      where: and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId), eq(memberships.status, 'active')),
    });
    return Boolean(membership);
  }

  private async getRow(id: string) {
    return this.db.query.workspaceFiles.findFirst({ where: eq(workspaceFiles.id, id) });
  }

  /** INLINE capability-URL serve — `GET /files/:id`. Public unless the owning
   * workspace has private-attachments mode on. */
  async serveInline(id: string, request: FastifyRequest) {
    const row = await this.getRow(id);
    if (!row) throw new NotFoundException('File not found');
    if (row.revokedAt) throw new ForbiddenException('This file link has been revoked');

    const ws = await this.db.query.workspaces.findFirst({ where: eq(workspaces.id, row.workspaceId) });
    const privateMode = Boolean((ws?.settings as Record<string, unknown> | undefined)?.private_attachments);

    if (privateMode) {
      const identity = await this.resolveRequestUser(request);
      if (!identity) throw new UnauthorizedException('Authentication required');
      // A PAT is minted for one workspace (MN-122) — a token for workspace A must
      // not reach a file in workspace B, even with a guessed/valid-shaped id.
      // 404, not 403: the same no-leak convention AuthGuard already uses.
      if (identity.tokenWorkspaceId && identity.tokenWorkspaceId !== row.workspaceId) {
        throw new NotFoundException('File not found');
      }
      const member = await this.isActiveMember(row.workspaceId, identity.userId);
      if (!member) throw new NotFoundException('File not found');
    }

    return {
      stream: await getStorage().getStream(row.storageKey),
      mime: row.mime,
      /** Capability URLs (private mode off) stay cached-immutable — they're
       * content-addressed by an unguessable id and never change. Anything behind
       * private-attachments mode is access-checked per request and must not be
       * cached by a shared/proxy cache that could hand it to the wrong caller. */
      cacheable: !privateMode,
    };
  }

  /** Mint a signed, expiring download URL. Called only from an authenticated,
   * workspace-access-checked endpoint (`POST /workspaces/:ws/files/:id/download-url`)
   * — the mint step *is* the access check; the URL itself carries no further
   * auth requirement, by design (that's what makes it a signed URL). */
  async mintDownloadUrl(workspaceId: string, id: string) {
    const row = await this.getRow(id);
    // Tenant check: a file id only mints a URL within the workspace it belongs to.
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundException('File not found');
    if (row.revokedAt) throw new ForbiddenException('This file has been revoked');
    const { url, expiresAt } = mintDownloadUrl(id);
    return { url, expires_at: expiresAt.toISOString() };
  }

  /** DOWNLOAD signed-URL serve — `GET /files/:id/download?expires=&sig=`. No
   * auth guard: the signature is the auth. Failure modes are deliberately
   * distinct HTTP statuses so a client (and a test) can tell them apart:
   *   401 — signature missing or does not verify (incl. tampered id/expires)
   *   410 — signature valid, but past its expiry
   *   403 — signature valid and unexpired, but the file has been revoked
   *   404 — no such file (id valid-shaped, row gone) */
  async streamForDownload(id: string, expiresRaw: string | undefined, sig: string | undefined) {
    if (!expiresRaw || !sig || !verifyDownloadSignature(id, expiresRaw, sig)) {
      throw new UnauthorizedException('Invalid or missing signature');
    }
    const expiresEpochSeconds = Number(expiresRaw);
    if (!Number.isFinite(expiresEpochSeconds) || expiresEpochSeconds < Date.now() / 1000) {
      throw new GoneException('This download link has expired');
    }
    const row = await this.getRow(id);
    if (!row) throw new NotFoundException('File not found');
    if (row.revokedAt) throw new ForbiddenException('This file has been revoked');
    return {
      stream: await getStorage().getStream(row.storageKey),
      mime: row.mime,
      filename: row.filename || 'download',
    };
  }

  /** Operator/owner revoke — kills both the capability URL and every
   * already-minted signed download URL for this file, immediately and without
   * needing to know which URLs exist. There is no un-revoke. */
  async revoke(workspaceId: string, id: string) {
    const row = await this.getRow(id);
    if (!row || row.workspaceId !== workspaceId) throw new NotFoundException('File not found');
    await this.db.update(workspaceFiles).set({ revokedAt: new Date() }).where(eq(workspaceFiles.id, id));
    return { revoked: true };
  }
}
