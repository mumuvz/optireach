import { countWords, type ContentVersionSource } from '@surfaced/shared';
import type { ContentVersion, Prisma, PrismaClient } from '../db';

export interface NewVersionData {
  title: string;
  body: string;
  outline?: Prisma.InputJsonValue | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  faqs?: Prisma.InputJsonValue | null;
  internalLinks?: Prisma.InputJsonValue | null;
  schemaJsonLd?: Prisma.InputJsonValue | null;
  source: ContentVersionSource;
  provider?: string | null;
  model?: string | null;
  isDevAdapter?: boolean;
  generationJobId?: string | null;
  note?: string | null;
  createdById?: string | null;
}

const jsonOrUndefined = (value: Prisma.InputJsonValue | null | undefined) =>
  value === null ? undefined : value;

/**
 * Appends a version to a document. The document row is locked while the next version number is
 * computed, so concurrent saves never collide; the document's denormalized fields are updated.
 */
export async function createContentVersion(
  prisma: PrismaClient,
  documentId: string,
  data: NewVersionData,
): Promise<ContentVersion> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM content_documents WHERE id = ${documentId} FOR UPDATE`;
    const latest = await tx.contentVersion.findFirst({
      where: { documentId },
      orderBy: { versionNumber: 'desc' },
      select: { versionNumber: true },
    });
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const wordCount = countWords(data.body);
    const version = await tx.contentVersion.create({
      data: {
        documentId,
        versionNumber,
        title: data.title.slice(0, 255),
        body: data.body,
        outline: jsonOrUndefined(data.outline),
        metaTitle: data.metaTitle?.slice(0, 255) ?? null,
        metaDescription: data.metaDescription?.slice(0, 500) ?? null,
        faqs: jsonOrUndefined(data.faqs),
        internalLinks: jsonOrUndefined(data.internalLinks),
        schemaJsonLd: jsonOrUndefined(data.schemaJsonLd),
        wordCount,
        source: data.source,
        provider: data.provider ?? null,
        model: data.model ?? null,
        isDevAdapter: data.isDevAdapter ?? false,
        generationJobId: data.generationJobId ?? null,
        note: data.note?.slice(0, 500) ?? null,
        createdById: data.createdById ?? null,
      },
    });
    await tx.contentDocument.update({
      where: { id: documentId },
      data: { latestVersion: versionNumber, wordCount, title: data.title.slice(0, 255) },
    });
    return version;
  });
}

export async function latestVersion(
  prisma: PrismaClient,
  documentId: string,
): Promise<ContentVersion | null> {
  return prisma.contentVersion.findFirst({ where: { documentId }, orderBy: { versionNumber: 'desc' } });
}
