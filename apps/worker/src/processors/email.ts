import { deliverQueuedEmail } from '@surfaced/core/email';
import type { EmailJobData } from '@surfaced/core/queue';
import type { Job } from 'bullmq';
import { runTracked, type WorkerContext } from '../runtime';

export function emailProcessor(ctx: WorkerContext) {
  return async (job: Job<EmailJobData>) =>
    runTracked(ctx, job, async () => {
      const result = await deliverQueuedEmail(ctx.prisma, job.data.deliveryId, job.data.encryptedMessage);
      // Never report a locally logged email as delivered.
      return { deliveryId: job.data.deliveryId, status: result.status };
    });
}
