import { syncMerchantCenter } from '@surfaced/core/commerce';
import { errorMessage } from '@surfaced/core/errors';
import { syncSearchConsole } from '@surfaced/core/integrations';
import { syncBusinessProfile } from '@surfaced/core/local';
import type { IntegrationSyncJobData } from '@surfaced/core/queue';
import type { Job } from 'bullmq';
import { runTracked, type WorkerContext } from '../runtime';

export function integrationSyncProcessor(ctx: WorkerContext) {
  return async (job: Job<IntegrationSyncJobData>) =>
    runTracked(
      ctx,
      job,
      async () => {
        const integration = await ctx.prisma.integration.findUniqueOrThrow({
          where: { id: job.data.integrationId },
          select: { provider: true },
        });
        if (integration.provider === 'GOOGLE_BUSINESS_PROFILE')
          return syncBusinessProfile(ctx.prisma, job.data.integrationId);
        if (integration.provider === 'GOOGLE_MERCHANT_CENTER') {
          const result = await syncMerchantCenter(ctx.prisma, job.data.integrationId);
          return { products: result.products, removed: result.removed, limitedByPlan: result.limitedByPlan };
        }
        return syncSearchConsole(ctx.prisma, job.data.integrationId);
      },
      async (error) => {
        await ctx.prisma.integration.update({
          where: { id: job.data.integrationId },
          data: { lastSyncStatus: 'FAILED', lastError: errorMessage(error).slice(0, 2000) },
        });
      },
    );
}
