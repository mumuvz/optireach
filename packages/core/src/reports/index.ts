import type { PrismaClient, Prisma } from '../db';
import { queueEmail } from '../email';
import { getEnv } from '../env';
import type { JobTracker } from '../jobs';
import { notifyWorkspace } from '../notifications';
import type { QueueGateway } from '../queue';
import { getStorage } from '../storage';
import { emailOptedInUsers } from '../audit/pipeline';
import { buildReportData } from './data';
import { renderReportHtml } from './html';
import { PdfUnavailableError, renderPdf } from './pdf';

export * from './data';
export * from './html';
export * from './pdf';
export * from './module-pdf';

export function reportStorageKeys(workspaceId: string, reportId: string) {
  return { html: `reports/${workspaceId}/${reportId}.html`, pdf: `reports/${workspaceId}/${reportId}.pdf` };
}

/**
 * Removes the stored HTML/PDF files of matching reports. Call it before deleting reports, projects
 * or workspaces: the database rows cascade, but files in storage do not.
 */
export async function removeReportFiles(
  prisma: PrismaClient,
  where: Prisma.ReportWhereInput,
): Promise<number> {
  const reports = await prisma.report.findMany({ where, select: { htmlPath: true, pdfPath: true } });
  const keys = reports.flatMap((r) => [r.htmlPath, r.pdfPath]).filter((k): k is string => Boolean(k));
  const storage = getStorage();
  await Promise.all(keys.map((key) => storage.remove(key)));
  return keys.length;
}

/** Generates a report's HTML and (when a renderer is available) PDF, then marks it READY. */
export async function executeReportJob(
  deps: { prisma: PrismaClient; queues: QueueGateway },
  reportId: string,
  tracker: JobTracker | null,
) {
  const { prisma } = deps;
  const report = await prisma.report.update({
    where: { id: reportId },
    data: { status: 'GENERATING', errorMessage: null },
    include: { project: true },
  });
  await tracker?.progress(10, 'Collecting project data', true);
  const data = await buildReportData(prisma, { reportId });
  await tracker?.progress(50, 'Rendering HTML', true);
  const html = renderReportHtml(data);
  const keys = reportStorageKeys(report.workspaceId, report.id);
  const storage = getStorage();
  const htmlFile = await storage.put(keys.html, html);

  let pdfStatus: 'READY' | 'UNAVAILABLE' | 'FAILED';
  let pdfPath: string | null = null;
  let pdfSize = 0;
  let pdfNote: string | null = null;
  await tracker?.progress(70, 'Rendering PDF', true);
  try {
    const pdf = await renderPdf(html);
    const saved = await storage.put(keys.pdf, pdf);
    pdfStatus = 'READY';
    pdfPath = keys.pdf;
    pdfSize = saved.size;
  } catch (error) {
    pdfStatus = error instanceof PdfUnavailableError ? 'UNAVAILABLE' : 'FAILED';
    pdfNote = error instanceof Error ? error.message : 'PDF rendering failed';
  }

  const summary = {
    ...((report.summary as Record<string, unknown> | null) ?? {}),
    score: data.audit?.score ?? null,
    mentionRate: data.visibility?.metrics.mentionRate ?? null,
    citationRate: data.visibility?.metrics.citationRate ?? null,
    observations: data.visibility?.metrics.totals.observations ?? 0,
    issues: data.audit?.issueCounts.total ?? null,
    pdfNote,
  };
  await prisma.report.update({
    where: { id: reportId },
    data: {
      status: 'READY',
      htmlPath: keys.html,
      pdfPath,
      pdfStatus,
      sizeBytes: htmlFile.size + pdfSize,
      limitations: data.limitations as Prisma.InputJsonValue,
      summary: summary as Prisma.InputJsonValue,
      generatedAt: new Date(),
    },
  });

  const link = `/app/p/${report.projectId}/reports/${report.id}`;
  const userIds = await notifyWorkspace(prisma, report.workspaceId, {
    type: 'report.ready',
    title: `Report ready: ${report.title}`,
    body: `${report.project.name} · ${data.limitations.length} data note(s)`,
    link,
  });
  await emailOptedInUsers(deps, userIds, 'reportReady', (user) =>
    queueEmail(prisma, deps.queues, {
      to: user.email,
      template: 'report_ready',
      data: {
        projectName: report.project.name,
        reportTitle: report.title,
        url: `${getEnv().APP_URL}${link}`,
      },
      userId: user.id,
      workspaceId: report.workspaceId,
    }),
  );
  return { reportId, pdfStatus, limitations: data.limitations.length };
}
