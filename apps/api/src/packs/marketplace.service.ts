import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  compareSemver,
  packManifestSchema,
  packListingMetaSchema,
} from '@storyos/schemas';
import type {
  PackListingMeta,
  PackManifest,
  PackSubmission,
  PackSubmissionStatus,
  PublishedPackCard,
  PublishedPackDetail,
  PublishedPackVersion,
} from '@storyos/schemas';
import { DB } from '../db/db.module';
import type { Db } from '../db/client';
import { packSubmissions, publishedPackVersions, publishedPacks } from '../db/schema';
import type { Membership } from '../workspaces/workspace-access.guard';
import { PACK_REGISTRY } from './registry';

type SubmissionRow = typeof packSubmissions.$inferSelect;
type PublishedPackRow = typeof publishedPacks.$inferSelect;
type PublishedPackVersionRow = typeof publishedPackVersions.$inferSelect;

/**
 * Community Marketplace (MN-220) — submit → review → publish, v1 curated.
 *
 * ── Why this is a separate service from `PacksService` ──────────────────────
 *
 * `PacksService` is the installer (MN-218/#160) and the collision-aware
 * install tracker (MN-219/#161); neither of those cares where a manifest came
 * from. This service is the OTHER half of a pack's life — how a manifest
 * *becomes* something installable by someone other than its author — and it
 * never touches a live workspace's schema. Installing a marketplace pack is
 * still `PacksService.install`/`preview` given the manifest this service
 * hands back from `getPublished`; there is no second installer here, same
 * "one walk" discipline `PacksService`'s own doc describes for the Architect.
 *
 * ── Why approval is the only path to `published_packs` ──────────────────────
 *
 * The ticket (MN-220) is explicit: v1 is curated, not an open marketplace.
 * The simplest correct reading of that is structural, not a policy flag
 * someone could flip later by mistake — `submit` only ever writes to
 * `pack_submissions`, and `published_packs`/`published_pack_versions` are
 * written to by exactly one method, `review`, and only on `action: 'approve'`.
 * A future open marketplace would need a genuinely different write path, not
 * a config toggle on this one — which is the point.
 */
@Injectable()
export class MarketplaceService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // ── submit ─────────────────────────────────────────────────────────────────

  /**
   * Submit a manifest for review (the author flow's second step — exporting
   * the manifest itself is `PacksService.export`, already shipped).
   *
   * Validated exactly like `install`/`preview`: the manifest arrives as
   * `unknown` and is parsed against `packManifestSchema` here, at the one
   * boundary that matters, rather than at the DTO/pipe level — see
   * `PacksController`'s doc for why a malformed manifest deserves a 422
   * naming which part is wrong, not a generic 400.
   */
  async submit(
    membership: Membership,
    rawManifest: unknown,
    rawMeta: unknown,
  ): Promise<PackSubmission> {
    const manifest = this.parseManifest(rawManifest);
    const meta = this.parseMeta(rawMeta);

    const [row] = await this.db
      .insert(packSubmissions)
      .values({
        workspaceId: membership.workspaceId,
        submittedBy: membership.userId,
        slug: manifest.slug,
        name: manifest.name,
        version: manifest.version,
        vertical: meta.vertical,
        screenshots: meta.screenshots,
        manifest,
        status: 'pending',
      })
      .returning();
    return this.toSubmission(row!, manifest);
  }

  /** This workspace's own submissions, newest first — the author's status tracker. */
  async listMySubmissions(membership: Membership): Promise<PackSubmission[]> {
    const rows = await this.db.query.packSubmissions.findMany({
      where: eq(packSubmissions.workspaceId, membership.workspaceId),
      orderBy: (t, { desc: d }) => [d(t.createdAt)],
    });
    return rows.map((r) => this.toSubmission(r, r.manifest as PackManifest));
  }

  // ── moderation (platform-admin only — see admin.controller.ts) ─────────────

  /** Every submission, optionally filtered by status — the review queue. */
  async listAllSubmissions(status?: PackSubmissionStatus): Promise<PackSubmission[]> {
    const rows = await this.db.query.packSubmissions.findMany({
      where: status ? eq(packSubmissions.status, status) : undefined,
      orderBy: (t, { desc: d }) => [d(t.createdAt)],
    });
    return rows.map((r) => this.toSubmission(r, r.manifest as PackManifest));
  }

  /**
   * Approve or reject a pending submission.
   *
   * Approve is the only write path to `published_packs`/
   * `published_pack_versions` — see this class's own doc. It also enforces
   * the one rule versioning needs to mean anything: a new version must be
   * strictly newer (semver) than whatever is already published, so
   * "update available" can trust a plain `compareSemver` rather than
   * guessing at intent from two submissions racing each other.
   */
  async review(
    reviewerUserId: string,
    submissionId: string,
    action: 'approve' | 'reject',
    notes?: string,
  ): Promise<PackSubmission> {
    const submission = await this.db.query.packSubmissions.findFirst({
      where: eq(packSubmissions.id, submissionId),
    });
    if (!submission) {
      throw new NotFoundException(`No submission "${submissionId}".`);
    }
    if (submission.status !== 'pending') {
      throw new UnprocessableEntityException(
        `Submission "${submission.name}" was already ${submission.status} — review acts on a pending submission only.`,
      );
    }

    const manifest = submission.manifest as PackManifest;

    if (action === 'approve') {
      const existing = await this.db.query.publishedPacks.findFirst({
        where: eq(publishedPacks.slug, submission.slug),
      });
      if (existing && compareSemver(submission.version, existing.latestVersion) <= 0) {
        throw new UnprocessableEntityException(
          `"${submission.slug}" is already published at v${existing.latestVersion} — a new submission must ` +
            `carry a newer version, not v${submission.version}.`,
        );
      }

      let published: PublishedPackRow;
      if (existing) {
        const [row] = await this.db
          .update(publishedPacks)
          .set({
            name: submission.name,
            summary: manifest.summary,
            vertical: submission.vertical,
            license: manifest.license,
            attribution: manifest.attribution,
            screenshots: submission.screenshots,
            latestVersion: submission.version,
          })
          .where(eq(publishedPacks.id, existing.id))
          .returning();
        published = row!;
      } else {
        const [row] = await this.db
          .insert(publishedPacks)
          .values({
            slug: submission.slug,
            name: submission.name,
            summary: manifest.summary,
            vertical: submission.vertical,
            license: manifest.license,
            attribution: manifest.attribution,
            screenshots: submission.screenshots,
            latestVersion: submission.version,
            submittedByWorkspaceId: submission.workspaceId,
          })
          .returning();
        published = row!;
      }

      await this.db.insert(publishedPackVersions).values({
        publishedPackId: published!.id,
        submissionId: submission.id,
        version: submission.version,
        changelog: manifest.upgrade_notes,
        manifest,
      });
    }

    const [updated] = await this.db
      .update(packSubmissions)
      .set({
        status: action === 'approve' ? 'approved' : 'rejected',
        reviewNotes: notes,
        reviewedBy: reviewerUserId,
        reviewedAt: new Date(),
      })
      .where(eq(packSubmissions.id, submissionId))
      .returning();
    return this.toSubmission(updated!, manifest);
  }

  // ── marketplace listing (in-app browse — MN-220) ────────────────────────────

  /** Every published community pack, newest first — the marketplace browse view. */
  async listPublished(): Promise<PublishedPackCard[]> {
    const rows = await this.db.query.publishedPacks.findMany({
      orderBy: (t, { desc: d }) => [d(t.createdAt)],
    });
    return Promise.all(rows.map((r) => this.toCard(r)));
  }

  /** One published pack: card + manifest of the latest version + full changelog — the install source. */
  async getPublished(slug: string): Promise<PublishedPackDetail> {
    const row = await this.db.query.publishedPacks.findFirst({
      where: eq(publishedPacks.slug, slug),
    });
    if (!row) throw new NotFoundException(`No published pack "${slug}".`);

    const versionRows = await this.db.query.publishedPackVersions.findMany({
      where: eq(publishedPackVersions.publishedPackId, row.id),
      orderBy: (t, { desc: d }) => [d(t.publishedAt)],
    });
    const latest = versionRows.find((v) => v.version === row.latestVersion) ?? versionRows[0];
    if (!latest) throw new NotFoundException(`"${slug}" has no published version.`);

    return {
      ...(await this.toCard(row)),
      manifest: latest.manifest as PackManifest,
      versions: versionRows.map((v) => this.toVersion(v)),
    };
  }

  /**
   * The latest version of `slug`, wherever it's catalogued — the built-in
   * `PACK_REGISTRY` or a published community pack — or `null` if `slug`
   * matches neither. `PacksService.listInstalls` is the only caller: it never
   * trusts a tracked install's own `version` column for "what's current",
   * only this live lookup, so an install of a pack that's since been
   * unpublished quietly stops reporting an update rather than reporting a
   * stale one.
   */
  async latestVersionOf(slug: string): Promise<string | null> {
    const builtin = PACK_REGISTRY.find((p) => p.slug === slug);
    if (builtin) return builtin.manifest.version;

    const row = await this.db.query.publishedPacks.findFirst({
      where: eq(publishedPacks.slug, slug),
    });
    return row?.latestVersion ?? null;
  }

  // ── mapping ──────────────────────────────────────────────────────────────

  private parseManifest(rawManifest: unknown): PackManifest {
    const parsed = packManifestSchema.safeParse(rawManifest);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `This is not a valid pack manifest: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }

  private parseMeta(rawMeta: unknown): PackListingMeta {
    const parsed = packListingMetaSchema.safeParse(rawMeta);
    if (!parsed.success) {
      throw new UnprocessableEntityException(
        `Invalid listing metadata: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }

  private toSubmission(row: SubmissionRow, manifest: PackManifest): PackSubmission {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      version: row.version,
      summary: manifest.summary,
      license: manifest.license,
      attribution: manifest.attribution,
      vertical: row.vertical,
      screenshots: row.screenshots as string[],
      requires: manifest.requires,
      status: row.status,
      review_notes: row.reviewNotes ?? undefined,
      submitted_by: row.submittedBy,
      submitted_at: row.createdAt.toISOString(),
      reviewed_by: row.reviewedBy ?? undefined,
      reviewed_at: row.reviewedAt?.toISOString(),
    };
  }

  private async toCard(row: PublishedPackRow): Promise<PublishedPackCard> {
    return {
      slug: row.slug,
      name: row.name,
      summary: row.summary,
      vertical: row.vertical,
      license: row.license,
      attribution: row.attribution ?? undefined,
      screenshots: row.screenshots as string[],
      latest_version: row.latestVersion,
      requires: await this.requiresOf(row),
      published_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    };
  }

  /** `requires` lives on the manifest, not the card row — read off the latest version. */
  private async requiresOf(row: PublishedPackRow): Promise<PublishedPackCard['requires']> {
    const latest = await this.db.query.publishedPackVersions.findFirst({
      where: and(
        eq(publishedPackVersions.publishedPackId, row.id),
        eq(publishedPackVersions.version, row.latestVersion),
      ),
    });
    const manifest = latest?.manifest as PackManifest | undefined;
    return manifest?.requires ?? { connections: [], ai: 'none' };
  }

  private toVersion(row: PublishedPackVersionRow): PublishedPackVersion {
    return {
      version: row.version,
      changelog: row.changelog ?? undefined,
      published_at: row.publishedAt.toISOString(),
    };
  }
}
