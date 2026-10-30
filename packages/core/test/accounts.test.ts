import { DEFAULT_CRAWL_SETTINGS } from '@surfaced/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processAccountDeletions } from '../src/accounts';
import { ensureDefaultPlans } from '../src/billing';
import { randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma } from '../src/db';
import { getLogger } from '../src/logger';
import { getStorage } from '../src/storage';

const prisma = getPrisma();
const logger = getLogger('accounts-test');
const DAY = 24 * 3600 * 1000;
const slug = () =>
  `acct-${randomToken(8)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}`;

beforeAll(async () => {
  await ensureDefaultPlans(prisma);
});
afterAll(async () => {
  await disconnectPrisma();
});

async function user(requestedDaysAgo: number | null) {
  return prisma.user.create({
    data: {
      email: `${slug()}@example.test`,
      name: 'Account Test',
      passwordHash: 'x',
      deletionRequestedAt: requestedDaysAgo === null ? null : new Date(Date.now() - requestedDaysAgo * DAY),
    },
  });
}

async function workspace(
  members: { userId: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' }[],
  provider: 'NONE' | 'STRIPE' = 'NONE',
) {
  const free = await prisma.subscriptionPlan.findUniqueOrThrow({
    where: { key: provider === 'NONE' ? 'FREE' : 'STARTER' },
  });
  return prisma.workspace.create({
    data: {
      name: `WS ${randomToken(4)}`,
      slug: slug(),
      members: { create: members },
      subscription: {
        create: {
          planId: free.id,
          status: 'ACTIVE',
          provider,
          providerSubscriptionId: provider === 'STRIPE' ? `sub_${randomToken(8)}` : null,
        },
      },
    },
  });
}

describe('account deletion after the grace period', () => {
  it('deletes the account, its solo workspaces and their report files, and keeps shared workspaces', async () => {
    const leaving = await user(15);
    const colleague = await user(null);
    const solo = await workspace([{ userId: leaving.id, role: 'OWNER' }]);
    const shared = await workspace([
      { userId: colleague.id, role: 'OWNER' },
      { userId: leaving.id, role: 'MEMBER' },
    ]);
    const project = await prisma.project.create({
      data: {
        workspaceId: solo.id,
        name: 'Solo',
        websiteUrl: 'https://solo.example.com/',
        domain: 'solo.example.com',
        targetCountries: ['US'],
        targetLanguages: ['en'],
        crawlSettings: DEFAULT_CRAWL_SETTINGS,
      },
    });
    const key = `reports/${solo.id}/test-report.html`;
    await getStorage().put(key, '<p>report</p>');
    await prisma.report.create({
      data: {
        workspaceId: solo.id,
        projectId: project.id,
        title: 'R',
        sections: [],
        dateFrom: new Date(),
        dateTo: new Date(),
        status: 'READY',
        htmlPath: key,
      },
    });
    await prisma.emailDelivery.create({
      data: {
        userId: leaving.id,
        toAddress: leaving.email,
        template: 'verify_email',
        subject: 'x',
        provider: 'console',
      },
    });

    const result = await processAccountDeletions({ prisma, logger });
    expect(result.deferred.find((d) => d.id === leaving.id)).toBeUndefined();
    expect(await prisma.user.findUnique({ where: { id: leaving.id } })).toBeNull();
    expect(await prisma.workspace.findUnique({ where: { id: solo.id } })).toBeNull();
    expect(await prisma.project.findUnique({ where: { id: project.id } })).toBeNull();
    expect(await getStorage().exists(key)).toBe(false);
    expect(await prisma.emailDelivery.count({ where: { userId: leaving.id } })).toBe(0);
    expect(await prisma.workspace.findUnique({ where: { id: shared.id } })).not.toBeNull();
    expect(await prisma.workspaceMember.count({ where: { workspaceId: shared.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'user.deleted', targetId: leaving.id } })).toBe(1);
  });

  it('defers sole owners of shared workspaces and active paid subscriptions, notifying once a week', async () => {
    const owner = await user(20);
    const admin = await user(null);
    await workspace([
      { userId: owner.id, role: 'OWNER' },
      { userId: admin.id, role: 'ADMIN' },
    ]);
    const payer = await user(20);
    await workspace([{ userId: payer.id, role: 'OWNER' }], 'STRIPE');
    const recent = await user(3);

    const first = await processAccountDeletions({ prisma, logger });
    expect(first.deferred.find((d) => d.id === owner.id)?.reason).toMatch(/only owner/);
    expect(first.deferred.find((d) => d.id === payer.id)?.reason).toMatch(/active paid subscription/);
    await processAccountDeletions({ prisma, logger });

    for (const u of [owner, payer, recent])
      expect(await prisma.user.findUnique({ where: { id: u.id } })).not.toBeNull();
    expect(
      await prisma.notification.count({ where: { userId: owner.id, type: 'account_deletion_blocked' } }),
    ).toBe(1);
    expect(await prisma.notification.count({ where: { userId: recent.id } })).toBe(0);
  });
});
