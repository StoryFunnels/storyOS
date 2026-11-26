import { and, eq } from 'drizzle-orm';
import { codedException } from '../../common/coded-exception';
import type { Db } from '../../db/client';
import { workspaceFiles } from '../../db/schema';
import { getStorage } from '../../attachments/storage';
import { blocksToHtml } from './blocks-to-html';
import type { PdfQueue, PdfRenderer } from './pdf-renderer';

/** #262 — a document's HTML (before images) past this is refused rather than sent to a small host's browser. */
const MAX_PDF_HTML_CHARS = 6_000_000;
/** Raw image bytes inlined into ONE export. Past it, further images become a visible placeholder. */
const MAX_PDF_IMAGE_BYTES = 24 * 1024 * 1024;
/** `/api/v1/files/<uuid>` — how the editor stores an uploaded image (see FilesService.upload). */
const EDITOR_FILE_PATH = /^\/api\/v1\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * BlockNote blocks to PDF: the ONE path both the document export (#262) and the automation's attach_pdf (#877) take, so
 * the image and size rules cannot drift between them.
 *
 * Images are the careful part. An editor image is stored as `/api/v1/files/<id>`; it is read STRAIGHT FROM STORAGE and
 * inlined as a data URI, never fetched over HTTP, because (a) the sidecar has no egress and (b) fetching a URL a user typed
 * into a document would be an SSRF primitive. The file row must belong to THIS workspace and not be revoked, so a pasted link
 * to another workspace's image does not leak it into an export. Anything else (an external URL, a file from elsewhere, one
 * over budget) renders as a visible placeholder and is counted.
 *
 * This renders what it is GIVEN. Whether the caller may read those blocks is the caller's question, answered before this.
 */
export async function renderBlocksToPdf(
  deps: { db: Db; pdf: PdfRenderer },
  input: { workspaceId: string; title: string; blocks: unknown; queue?: PdfQueue },
): Promise<{ pdf: Buffer; skippedImages: number }> {
  let imageBytesLeft = MAX_PDF_IMAGE_BYTES;
  let inlinedImageChars = 0;
  const resolveImage = async (url: string): Promise<string | null> => {
    let fileId: string | undefined;
    try {
      fileId = EDITOR_FILE_PATH.exec(new URL(url, 'http://storyos.invalid').pathname)?.[1];
    } catch {
      return null;
    }
    if (!fileId) return null;
    const file = await deps.db.query.workspaceFiles.findFirst({
      where: and(eq(workspaceFiles.id, fileId), eq(workspaceFiles.workspaceId, input.workspaceId)),
    });
    if (!file || file.revokedAt) return null;
    if (!/^image\/[a-z0-9.+-]+$/i.test(file.mime)) return null;
    if (file.size > imageBytesLeft) return null;
    const chunks: Buffer[] = [];
    for await (const chunk of await getStorage().getStream(file.storageKey)) chunks.push(Buffer.from(chunk as Buffer));
    const data = Buffer.concat(chunks);
    if (data.length > imageBytesLeft) return null;
    imageBytesLeft -= data.length;
    const dataUri = `data:${file.mime};base64,${data.toString('base64')}`;
    inlinedImageChars += dataUri.length;
    return dataUri;
  };

  const { html, skippedImages } = await blocksToHtml(input.title, input.blocks, { resolveImage });
  // The cap is on the document's own text and structure; image bytes have their own budget above.
  const measured = html.length - inlinedImageChars;
  if (measured > MAX_PDF_HTML_CHARS) {
    // The figures are FIELDS: "too large" without a number is not actionable, and a
    // client cannot show, compare or localise a number buried in a sentence.
    throw codedException(
      413,
      'document_too_large',
      `This document is too large to export as a PDF (${measured.toLocaleString('en-US')} characters of content; the limit is ${MAX_PDF_HTML_CHARS.toLocaleString('en-US')}).`,
      { limit: MAX_PDF_HTML_CHARS, measured, unit: 'characters' },
    );
  }
  const pdf = await deps.pdf.render(html, input.queue);
  return { pdf, skippedImages };
}
