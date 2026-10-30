import { getWorkspacePlan } from '@surfaced/core/billing';
import { getEnv } from '@surfaced/core/env';
import { Errors } from '@surfaced/core/errors';
import { createJobRecord, enqueueJobRecord, toJobDto } from '@surfaced/core/jobs';
import { getStorage } from '@surfaced/core/storage';
import { assertMonthlyQuota, recordUsage, withWorkspaceLock } from '@surfaced/core/usage';
import { idSchema, paginationSchema, reportCreateSchema, slugify } from '@surfaced/shared';
import type { Report } from '@surfaced/core/db';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { accepted, iso, noContent, ok, pageMeta, paginate } from '../lib/http';
import { route, type AnyRoute } from '../lib/router';
import { requireProjectAccess } from '../services/access';
import type { AppDeps, AuthUser } from '../types';

function toReportDto(r: Report) {
  return {
    id: r.id,
    projectId: r.projectId,
    title: r.title,
    sections: r.sections,
    dateFrom: r.dateFrom.toISOString(),
    dateTo: r.dateTo.toISOString(),
    status: r.status,
    pdfStatus: r.pdfStatus,
    sizeBytes: r.sizeBytes,
    limitations: r.limitations ?? [],
    summary: r.summary,
    whiteLabel: r.whiteLabel,
    errorMessage: r.errorMessage,
    generatedAt: iso(r.generatedAt),
    createdAt: r.createdAt.toISOString(),
  };
}

export function reportRoutes(deps: AppDeps): { project: AnyRoute[]; reports: AnyRoute[] } {
  const { prisma } = deps;
  const tags = ['Reports'];

  async function loadReport(
    user: AuthUser,
    reportId: string,
    permission: 'project.read' | 'report.delete' = 'project.read',
  ) {
    const report = await prisma.report.findUnique({ where: { id: reportId } });
    if (!report) throw Errors.notFound('Report');
    await requireProjectAccess(prisma, user, report.projectId, permission);
    return report;
  }

  const project: AnyRoute[] = [
    route({
      method: 'post',
      path: '/:projectId/reports',
      summary: 'Generate a report from stored project data for a date range (background job)',
      tags,
      auth: 'user',
      params: z.object({ projectId: idSchema }),
      body: reportCreateSchema,
      successStatus: 202,
      handler: async ({ user, params, body }) => {
        const { project: p } = await requireProjectAccess(prisma, user, params.projectId, 'report.create');
        const workspace = await prisma.workspace.findUniqueOrThrow({ where: { id: p.workspaceId } });
        const { limits } = await getWorkspacePlan(prisma, p.workspaceId);
        const whiteLabel =
          limits.whiteLabelReports && (workspace.whiteLabel as { enabled?: boolean } | null)?.enabled
            ? workspace.whiteLabel
            : undefined;
        const { report, job } = await withWorkspaceLock(prisma, p.workspaceId, async (tx) => {
          await assertMonthlyQuota(tx, p.workspaceId, 'REPORT');
          const report = await tx.report.create({
            data: {
              workspaceId: p.workspaceId,
              projectId: p.id,
              title: body.title,
              sections: body.sections,
              dateFrom: body.dateFrom,
              dateTo: body.dateTo,
              summary: { provider: body.provider },
              whiteLabel: whiteLabel ?? undefined,
              createdById: user.id,
            },
          });
          await recordUsage(tx, {
            workspaceId: p.workspaceId,
            projectId: p.id,
            metric: 'REPORT',
            quantity: 1,
            idempotencyKey: `report:${report.id}`,
          });
          const job = await createJobRecord(tx, {
            type: 'REPORT',
            queue: 'report',
            workspaceId: p.workspaceId,
            projectId: p.id,
            userId: user.id,
            entityType: 'Report',
            entityId: report.id,
            payload: { reportId: report.id },
            maxAttempts: 2,
          });
          return { report, job };
        });
        await enqueueJobRecord(prisma, deps.queues, job, 'report', {
          backgroundJobId: job.id,
          reportId: report.id,
        });
        return accepted({ jobId: job.id, reportId: report.id, status: 'QUEUED' });
      },
    }),
    route({
      method: 'get',
      path: '/:projectId/reports',
      summary: 'List reports',
      tags,
      auth: 'user',
      params: z.object({ projectId: idSchema }),
      query: paginationSchema,
      handler: async ({ user, params, query }) => {
        await requireProjectAccess(prisma, user, params.projectId, 'project.read');
        const [total, rows] = await Promise.all([
          prisma.report.count({ where: { projectId: params.projectId } }),
          prisma.report.findMany({
            where: { projectId: params.projectId },
            orderBy: { createdAt: 'desc' },
            ...paginate(query.page, query.pageSize),
          }),
        ]);
        return ok(rows.map(toReportDto), pageMeta(query.page, query.pageSize, total));
      },
    }),
  ];

  const reportParams = z.object({ reportId: idSchema });
  const reports: AnyRoute[] = [
    route({
      method: 'get',
      path: '/:reportId',
      summary: 'Report metadata and generation status',
      tags,
      auth: 'user',
      params: reportParams,
      handler: async ({ user, params }) => {
        const report = await loadReport(user, params.reportId);
        const job = await prisma.backgroundJob.findFirst({
          where: { entityType: 'Report', entityId: report.id },
          orderBy: { createdAt: 'desc' },
        });
        return ok({ ...toReportDto(report), job: job ? toJobDto(job) : null });
      },
    }),
    route({
      method: 'get',
      path: '/:reportId/html',
      summary: 'Report HTML (static; served with a sandboxing Content-Security-Policy)',
      tags,
      auth: 'user',
      params: reportParams,
      query: z.object({ download: z.enum(['1', 'true']).optional() }),
      produces: 'text/html',
      handler: async ({ res, user, params, query }) => {
        const report = await loadReport(user, params.reportId);
        if (report.status !== 'READY' || !report.htmlPath)
          throw Errors.conflict('This report is not ready yet.');
        const { stream, size } = await getStorage().getStream(report.htmlPath);
        const appOrigin = new URL(getEnv().APP_URL).origin;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Length', String(size));
        res.setHeader(
          'Content-Security-Policy',
          `default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self' ${appOrigin}; sandbox`,
        );
        res.setHeader(
          'Content-Disposition',
          `${query.download ? 'attachment' : 'inline'}; filename="${slugify(report.title) || 'report'}.html"`,
        );
        // Await the stream so the router sees a finished response (otherwise it would send 204).
        await pipeline(stream, res);
      },
    }),
    route({
      method: 'get',
      path: '/:reportId/pdf',
      summary: 'Download the report PDF (when the PDF renderer is available)',
      tags,
      auth: 'user',
      params: reportParams,
      produces: 'application/pdf',
      handler: async ({ res, user, params }) => {
        const report = await loadReport(user, params.reportId);
        if (report.pdfStatus !== 'READY' || !report.pdfPath) {
          throw Errors.conflict('A PDF is not available for this report. Use the HTML version.', {
            pdfStatus: report.pdfStatus,
          });
        }
        const { stream, size } = await getStorage().getStream(report.pdfPath);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', String(size));
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${slugify(report.title) || 'report'}.pdf"`,
        );
        await pipeline(stream, res);
      },
    }),
    route({
      method: 'delete',
      path: '/:reportId',
      summary: 'Delete a report and its files',
      tags,
      auth: 'user',
      params: reportParams,
      handler: async ({ user, params }) => {
        const report = await loadReport(user, params.reportId, 'report.delete');
        await Promise.all(
          [report.htmlPath, report.pdfPath]
            .filter((k): k is string => Boolean(k))
            .map((k) => getStorage().remove(k)),
        );
        await prisma.report.delete({ where: { id: report.id } });
        return noContent();
      },
    }),
  ];
  return { project, reports };
}
