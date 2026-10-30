// Extension foundation: agency access resolution, pooled billing, approvals, provider costs and live page checks.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  inheritedRole,
  listAccessibleWorkspaces,
  resolveMembership,
  workspaceParticipants,
} from '../src/access';
import {
  assertApproved,
  decideApproval,
  requestApproval,
  snapshotHash,
  stableStringify,
} from '../src/approvals';
import { billingGroupWorkspaceIds, ensureDefaultPlans, getWorkspacePlan } from '../src/billing';
import { estimateCostMicros, providerCostSummary, recordProviderUsage, selectRates } from '../src/costs';
import { SafeFetcher } from '../src/crawler';
import { randomToken } from '../src/crypto';
import { disconnectPrisma, getPrisma, type ProviderRate } from '../src/db';
import { assertMonthlyQuota, recordUsage } from '../src/usage';
import { analyzeHtml, checkPage, comparableUrl, matchLinkTarget, parseHreflangHeader } from '../src/verify';

const prisma = getPrisma();
const tag = () =>
  `fdn-${randomToken(8)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}`;

beforeAll(async () => {
  await ensureDefaultPlans(prisma);
});
afterAll(async () => {
  await disconnectPrisma();
});

async function newUser(label = 'User') {
  return prisma.user.create({
    data: { email: `${tag()}@example.test`, name: label, passwordHash: 'x', emailVerifiedAt: new Date() },
  });
}

async function newWorkspace(
  planKey: string,
  members: { userId: string; role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'CLIENT' }[],
) {
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { key: planKey } });
  return prisma.workspace.create({
    data: {
      name: `WS ${tag()}`,
      slug: tag(),
      members: { create: members },
      subscription: { create: { planId: plan.id, status: 'ACTIVE' } },
    },
  });
}

async function link(
  agencyWorkspaceId: string,
  clientWorkspaceId: string,
  data: Partial<{
    status: 'PENDING' | 'ACTIVE' | 'REVOKED';
    accessRole: 'ADMIN' | 'MEMBER';
    billingMode: 'AGENCY' | 'CLIENT';
    approvalsDelegated: boolean;
  }> = {},
) {
  return prisma.agencyClientLink.create({
    data: { agencyWorkspaceId, clientWorkspaceId, status: 'ACTIVE', ...data },
  });
}

describe('agency access resolution', () => {
  it('maps agency roles to the link access level and never inherits the client role', () => {
    expect(inheritedRole('OWNER', 'ADMIN')).toBe('ADMIN');
    expect(inheritedRole('ADMIN', 'MEMBER')).toBe('MEMBER');
    expect(inheritedRole('MEMBER', 'ADMIN')).toBe('MEMBER');
    expect(inheritedRole('CLIENT', 'ADMIN')).toBeNull();
  });

  it('grants inherited access only through an ACTIVE link and lists it with direct memberships', async () => {
    const [agencyAdmin, agencyMember, agencyClient, clientOwner, outsider] = await Promise.all([
      newUser('Agency admin'),
      newUser('Agency member'),
      newUser('Agency client user'),
      newUser('Client owner'),
      newUser('Outsider'),
    ]);
    const agency = await newWorkspace('AGENCY', [
      { userId: agencyAdmin.id, role: 'ADMIN' },
      { userId: agencyMember.id, role: 'MEMBER' },
      { userId: agencyClient.id, role: 'CLIENT' },
    ]);
    const client = await newWorkspace('FREE', [{ userId: clientOwner.id, role: 'OWNER' }]);

    // No link yet: no access.
    expect(await resolveMembership(prisma, agencyAdmin.id, client.id)).toBeNull();
    const pending = await link(agency.id, client.id, { status: 'PENDING' });
    expect(await resolveMembership(prisma, agencyAdmin.id, client.id)).toBeNull();

    await prisma.agencyClientLink.update({ where: { id: pending.id }, data: { status: 'ACTIVE' } });
    expect(await resolveMembership(prisma, agencyAdmin.id, client.id)).toMatchObject({
      role: 'ADMIN',
      via: 'AGENCY',
      agencyWorkspaceId: agency.id,
    });
    expect(await resolveMembership(prisma, agencyMember.id, client.id)).toMatchObject({
      role: 'MEMBER',
      via: 'AGENCY',
    });
    expect(await resolveMembership(prisma, agencyClient.id, client.id)).toBeNull();
    expect(await resolveMembership(prisma, outsider.id, client.id)).toBeNull();
    expect(await resolveMembership(prisma, clientOwner.id, client.id)).toMatchObject({
      role: 'OWNER',
      via: 'DIRECT',
    });

    const listed = await listAccessibleWorkspaces(prisma, agencyAdmin.id);
    expect(listed.map((w) => [w.workspaceId, w.via])).toEqual([
      [agency.id, 'DIRECT'],
      [client.id, 'AGENCY'],
    ]);
    const participants = await workspaceParticipants(prisma, client.id);
    expect(participants.map((p) => p.userId).sort()).toEqual(
      [clientOwner.id, agencyAdmin.id, agencyMember.id].sort(),
    );

    await prisma.agencyClientLink.update({ where: { id: pending.id }, data: { status: 'REVOKED' } });
    expect(await resolveMembership(prisma, agencyAdmin.id, client.id)).toBeNull();
    expect((await listAccessibleWorkspaces(prisma, agencyAdmin.id)).map((w) => w.workspaceId)).toEqual([
      agency.id,
    ]);
  });
});

describe('pooled billing for agency-billed clients', () => {
  it('applies the agency plan and pools monthly usage across the billing group', async () => {
    const owner = await newUser();
    const agency = await newWorkspace('AGENCY', [{ userId: owner.id, role: 'OWNER' }]);
    const billed = await newWorkspace('FREE', []);
    const selfPaying = await newWorkspace('FREE', [{ userId: owner.id, role: 'OWNER' }]);
    await link(agency.id, billed.id, { billingMode: 'AGENCY' });
    await link(agency.id, selfPaying.id, { billingMode: 'CLIENT' });

    expect((await getWorkspacePlan(prisma, billed.id)).plan.key).toBe('AGENCY');
    expect((await getWorkspacePlan(prisma, billed.id)).billingWorkspaceId).toBe(agency.id);
    expect((await getWorkspacePlan(prisma, selfPaying.id)).plan.key).toBe('FREE');
    expect((await billingGroupWorkspaceIds(prisma, billed.id)).sort()).toEqual([agency.id, billed.id].sort());

    // Usage recorded in the client workspace counts against the shared allowance.
    const limit = (await getWorkspacePlan(prisma, agency.id)).limits.reportsPerMonth;
    await recordUsage(prisma, {
      workspaceId: billed.id,
      metric: 'REPORT',
      quantity: limit,
      idempotencyKey: `pool:${billed.id}`,
    });
    await expect(assertMonthlyQuota(prisma, agency.id, 'REPORT')).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
    });
    await expect(assertMonthlyQuota(prisma, billed.id, 'REPORT')).rejects.toMatchObject({
      code: 'PLAN_LIMIT_REACHED',
    });
    // A client that pays for itself is not affected.
    await expect(assertMonthlyQuota(prisma, selfPaying.id, 'REPORT')).resolves.toMatchObject({ used: 0 });
  });
});

describe('approval requests', () => {
  it('hashes snapshots independently of key order', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(snapshotHash({ title: 'A', body: 'B' })).toBe(snapshotHash({ body: 'B', title: 'A' }));
    expect(snapshotHash({ title: 'A' })).not.toBe(snapshotHash({ title: 'A ' }));
  });

  it('reuses identical pending requests and supersedes older content', async () => {
    const owner = await newUser();
    const ws = await newWorkspace('FREE', [{ userId: owner.id, role: 'OWNER' }]);
    const entityId = randomToken(12)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'a')
      .padEnd(25, 'a')
      .slice(0, 25);
    const first = await requestApproval(prisma, {
      workspaceId: ws.id,
      entityType: 'LOCAL_POST',
      entityId,
      title: 'Holiday post',
      snapshot: { summary: 'Open late on Friday' },
      requestedById: owner.id,
    });
    const again = await requestApproval(prisma, {
      workspaceId: ws.id,
      entityType: 'LOCAL_POST',
      entityId,
      title: 'Holiday post',
      snapshot: { summary: 'Open late on Friday' },
      requestedById: owner.id,
    });
    expect(again.id).toBe(first.id);
    const edited = await requestApproval(prisma, {
      workspaceId: ws.id,
      entityType: 'LOCAL_POST',
      entityId,
      title: 'Holiday post',
      snapshot: { summary: 'Open late on Friday and Saturday' },
      requestedById: owner.id,
    });
    expect(edited.id).not.toBe(first.id);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(
      'SUPERSEDED',
    );
    expect(
      await prisma.domainEvent.count({ where: { workspaceId: ws.id, type: 'approval.requested' } }),
    ).toBe(2);
  });

  it('lets only customers decide (or a delegated agency) and binds the approval to the exact content', async () => {
    const [clientUser, member, agencyAdmin] = await Promise.all([
      newUser('Client'),
      newUser('Member'),
      newUser('Agency'),
    ]);
    const agency = await newWorkspace('AGENCY', [{ userId: agencyAdmin.id, role: 'ADMIN' }]);
    const ws = await newWorkspace('FREE', [
      { userId: clientUser.id, role: 'CLIENT' },
      { userId: member.id, role: 'MEMBER' },
    ]);
    const agencyLink = await link(agency.id, ws.id, { approvalsDelegated: false });
    const recordId = `cm${randomToken(16)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}`.slice(0, 25);
    const snapshot = { fields: { profile: { description: 'Family jewellers since 1984.' } } };
    const request = await requestApproval(prisma, {
      workspaceId: ws.id,
      entityType: 'LOCATION_CHANGE',
      entityId: recordId,
      title: 'Update description',
      snapshot,
      requestedById: agencyAdmin.id,
    });
    // The client was notified; the requester was not.
    expect(
      await prisma.notification.count({ where: { userId: clientUser.id, type: 'approval_requested' } }),
    ).toBe(1);
    expect(
      await prisma.notification.count({ where: { userId: agencyAdmin.id, type: 'approval_requested' } }),
    ).toBe(0);

    await expect(
      decideApproval(prisma, { approvalId: request.id, decision: 'APPROVED', actorUserId: member.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      decideApproval(prisma, { approvalId: request.id, decision: 'APPROVED', actorUserId: agencyAdmin.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      decideApproval(prisma, { approvalId: request.id, decision: 'REJECTED', actorUserId: clientUser.id }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' }); // a note is required

    const target = { workspaceId: ws.id, entityType: 'LOCATION_CHANGE' as const, entityId: request.entityId };
    await expect(assertApproved(prisma, target, snapshot)).rejects.toMatchObject({ code: 'CONFLICT' });
    const approved = await decideApproval(prisma, {
      approvalId: request.id,
      decision: 'APPROVED',
      actorUserId: clientUser.id,
    });
    expect(approved).toMatchObject({
      status: 'APPROVED',
      decidedById: clientUser.id,
      decidedVia: 'DIRECT_MEMBER',
    });
    await expect(
      decideApproval(prisma, { approvalId: request.id, decision: 'APPROVED', actorUserId: clientUser.id }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(assertApproved(prisma, target, snapshot)).resolves.toMatchObject({ id: request.id });
    // An approval never authorizes publishing in another workspace.
    await expect(
      assertApproved(prisma, { ...target, workspaceId: agency.id }, snapshot),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // Editing after approval needs a new approval.
    await expect(
      assertApproved(prisma, target, {
        fields: { profile: { description: 'Family jewellers since 1985.' } },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // With delegation the agency may decide, and the record says how.
    await prisma.agencyClientLink.update({
      where: { id: agencyLink.id },
      data: { approvalsDelegated: true },
    });
    const second = await requestApproval(prisma, {
      workspaceId: ws.id,
      entityType: 'REVIEW_REPLY',
      entityId: `r${recordId}`.slice(0, 25),
      title: 'Reply to review',
      snapshot: { comment: 'Thank you for visiting.' },
      requestedById: member.id,
    });
    const delegated = await decideApproval(prisma, {
      approvalId: second.id,
      decision: 'APPROVED',
      actorUserId: agencyAdmin.id,
    });
    expect(delegated.decidedVia).toBe('AGENCY_DELEGATED');
  });
});

describe('provider usage and costs', () => {
  const rate = (overrides: Partial<ProviderRate>): ProviderRate => ({
    id: randomToken(6),
    provider: 'openai',
    operation: null,
    unit: 'input_token',
    priceMicros: 150_000n,
    unitQuantity: 1_000_000,
    currency: 'USD',
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    note: null,
    createdById: null,
    createdAt: new Date(),
    ...overrides,
  });

  it('prefers operation-specific and newer rates, and never guesses a missing price', () => {
    const rates = [
      rate({ unit: 'input_token', priceMicros: 150_000n }),
      rate({ unit: 'input_token', operation: 'content_generation', priceMicros: 200_000n }),
      rate({ unit: 'output_token', priceMicros: 600_000n }),
      rate({ unit: 'output_token', priceMicros: 900_000n, effectiveFrom: new Date('2026-06-01T00:00:00Z') }),
    ];
    const chosen = selectRates(rates, 'content_generation');
    expect(chosen.get('input_token')?.priceMicros).toBe(200_000n);
    expect(chosen.get('output_token')?.priceMicros).toBe(900_000n);
    // 1,000,000 input tokens at $0.20 and 500,000 output tokens at $0.90 per million, requests unpriced.
    expect(
      estimateCostMicros({ inputTokens: 1_000_000, outputTokens: 500_000, requests: 0 }, chosen),
    ).toEqual({
      costMicros: 650_000n,
      currency: 'USD',
    });
    expect(estimateCostMicros({ inputTokens: 10, outputTokens: 10, requests: 1 }, chosen)).toBeNull();
  });

  it('records each call once and summarizes priced and unpriced usage', async () => {
    const owner = await newUser();
    const ws = await newWorkspace('FREE', [{ userId: owner.id, role: 'OWNER' }]);
    const provider = `test_${randomToken(4)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, 'x')}`;
    await prisma.providerRate.create({
      data: {
        provider,
        unit: 'request',
        priceMicros: 2_000n,
        unitQuantity: 1,
        effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      },
    });
    const key = `test:${randomToken(8)}`;
    expect(
      await recordProviderUsage(prisma, {
        workspaceId: ws.id,
        provider,
        operation: 'rank_check',
        idempotencyKey: key,
      }),
    ).toBe(true);
    expect(
      await recordProviderUsage(prisma, {
        workspaceId: ws.id,
        provider,
        operation: 'rank_check',
        idempotencyKey: key,
      }),
    ).toBe(false);
    await recordProviderUsage(prisma, {
      workspaceId: ws.id,
      provider,
      operation: 'rank_check',
      inputTokens: 5,
      idempotencyKey: `${key}:tokens`,
    });
    const [line] = await providerCostSummary(prisma, {
      workspaceIds: [ws.id],
      from: new Date(Date.now() - 3600_000),
      to: new Date(Date.now() + 3600_000),
    });
    expect(line).toMatchObject({ provider, calls: 2, unpricedCalls: 1, costMicros: { USD: 2000 } });
  });
});

describe('live page checks', () => {
  let server: Server;
  let origin = '';
  let shared: SafeFetcher;
  const fetcher = () => shared;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const send = (status: number, body: string, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
        res.end(body);
      };
      if (req.url === '/robots.txt')
        return send(200, 'User-agent: *\nDisallow: /members/\n', { 'content-type': 'text/plain' });
      if (req.url === '/article')
        return send(
          200,
          `<!doctype html><html lang="en"><head><title>Best jewellers</title>
           <link rel="canonical" href="${origin}/article">
           <link rel="alternate" hreflang="en-IN" href="${origin}/article">
           <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Article","headline":"Best jewellers"},{"@type":"Organization","name":"Press"}]}</script>
           </head><body><h1>Best jewellers in Surat</h1>
           <p>We visited <a href="https://www.shop.example/rings?utm_source=press" rel="nofollow sponsored">Shop Example rings</a>
           and <a href="https://blog.shop.example/">their blog</a>. Shop Example offers hallmarked gold.</p></body></html>`,
          { link: `<${origin}/hi/article>; rel="alternate"; hreflang="hi-IN"` },
        );
      if (req.url === '/moved') return send(301, '', { location: '/article' });
      if (req.url === '/to-members') return send(302, '', { location: '/members/area' });
      if (req.url === '/file.pdf') return send(200, '%PDF', { 'content-type': 'application/pdf' });
      return send(404, 'missing');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    shared = new SafeFetcher({ allowlist: ['127.0.0.1:*'], timeoutMs: 5000 });
  });
  afterAll(async () => {
    await shared.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('compares links without tracking parameters and matches exact pages or whole domains', () => {
    expect(comparableUrl('https://www.Shop.example/rings/?utm_source=x#top')).toBe(
      'https://shop.example/rings',
    );
    expect(
      matchLinkTarget('https://www.shop.example/rings?utm_medium=pr', 'https://shop.example/rings'),
    ).toBe('EXACT');
    expect(matchLinkTarget('https://blog.shop.example/', 'shop.example')).toBe('DOMAIN');
    expect(matchLinkTarget('https://shop.example.evil.test/', 'shop.example')).toBeNull();
    expect(
      parseHreflangHeader('<https://x.test/de>; rel="alternate"; hreflang="de"', 'https://x.test/'),
    ).toEqual([{ hreflang: 'de', href: 'https://x.test/de', source: 'header' }]);
  });

  it('reports live links with rel values, mentions, structured data and hreflang', async () => {
    const result = await checkPage(`${origin}/moved`, {
      fetcher: fetcher(),
      linkTargets: ['https://shop.example/rings', 'shop.example'],
      textNeedles: ['Shop Example', 'Not mentioned'],
    });
    expect(result).toMatchObject({
      status: 'OK',
      httpStatus: 200,
      redirects: 1,
      canonicalUrl: `${origin}/article`,
    });
    expect(result.links).toEqual([
      // Link URLs are normalized like crawled URLs (tracking parameters removed).
      {
        href: 'https://www.shop.example/rings',
        text: 'Shop Example rings',
        rel: ['nofollow', 'sponsored'],
        match: 'EXACT',
      },
      { href: 'https://blog.shop.example/', text: 'their blog', rel: [], match: 'DOMAIN' },
    ]);
    expect(result.textMatches).toEqual({ 'Shop Example': true, 'Not mentioned': false });
    expect(result.jsonLd.map((n) => n['@type'])).toEqual(['Article', 'Organization']);
    expect(result.hreflang.map((h) => [h.hreflang, h.source])).toEqual([
      ['en-IN', 'html'],
      ['hi-IN', 'header'],
    ]);
  });

  it('respects robots.txt on every hop and labels failures', async () => {
    expect((await checkPage(`${origin}/members/area`, { fetcher: fetcher() })).status).toBe(
      'BLOCKED_BY_ROBOTS',
    );
    expect((await checkPage(`${origin}/to-members`, { fetcher: fetcher() })).status).toBe(
      'BLOCKED_BY_ROBOTS',
    );
    expect(await checkPage(`${origin}/nothing`, { fetcher: fetcher() })).toMatchObject({
      status: 'HTTP_ERROR',
      httpStatus: 404,
    });
    expect((await checkPage(`${origin}/file.pdf`, { fetcher: fetcher() })).status).toBe('NOT_HTML');
    // Without the test allowlist, a private address is refused before any request.
    expect((await checkPage(`${origin}/article`)).status).toBe('UNSAFE_URL');
    expect((await checkPage('ftp://example.com/file')).status).toBe('UNSAFE_URL');
  });

  it('extracts noindex from meta robots and X-Robots-Tag', () => {
    expect(
      analyzeHtml('<meta name="robots" content="noindex,follow">', 'https://x.test/').robotsNoindex,
    ).toBe(true);
    expect(analyzeHtml('<p>ok</p>', 'https://x.test/', { xRobotsTag: 'noindex' }).robotsNoindex).toBe(true);
    expect(analyzeHtml('<p>ok</p>', 'https://x.test/').robotsNoindex).toBe(false);
  });
});
