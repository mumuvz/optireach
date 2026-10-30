import { idSchema } from '@surfaced/shared';
import { z } from 'zod';
import { route, type AnyRoute } from '../lib/router';
import { ExportService } from '../services/export.service';
import type { AppDeps } from '../types';

const params = z.object({ projectId: idSchema, module: z.string().trim().min(1).max(40) });

/** Per-module PDF export, mounted under /projects. */
export function projectExportRoutes(deps: AppDeps): AnyRoute[] {
  const service = new ExportService(deps);
  return [
    route({
      method: 'get',
      path: '/:projectId/export/:module',
      summary: 'Download a module’s current data as a PDF',
      description: 'Renders the module (audit, visibility, competitors, keywords, recommendations, content, answerability, trends) to a PDF.', // prettier-ignore
      tags: ['Export'],
      auth: 'user',
      params,
      produces: 'application/pdf',
      handler: async ({ res, user, params: p }) => {
        const { filename, buffer } = await service.pdf(user, p.projectId, p.module);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.status(200).send(buffer);
      },
    }),
  ];
}
