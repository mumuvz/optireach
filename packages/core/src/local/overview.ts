// Local Search & AI Visibility overview: one card per search surface, each from its own stored measurements. Surfaces
// are never merged into one number. A card without data says why: an account to connect, a source this installation
// does not have yet, or a surface that cannot be measured reliably.
import {
  CAPTURE_METHOD_LABELS,
  LOCAL_RANK_SOURCE_LABELS,
  RECOMMENDATION_OPEN_STATUSES,
  captureMethodOfProvider,
  observationProviderLabel,
  type LocalOverviewDto,
  type LocalRankSource,
  type LocalResult,
  type OverviewCard,
} from '@surfaced/shared';
import type { PrismaClient } from '../db';
import { getEnv } from '../env';
import { productSummary } from '../commerce/catalog';
import type { MerchantAccountSnapshot } from '../commerce/merchant-api';
import { profileRetentionCutoff, summarizeProfileMetrics } from './business-profile';
import { computeLocalHealth } from './health';

const DAY_MS = 24 * 3600 * 1000;
const FRESH_DAYS = 8;

const pct = (n: number | null) => (n === null ? null : `${Math.round(n * 10) / 10}%`);
const fmt = (n: number) => n.toLocaleString('en-US');
const day = (d: Date) => d.toISOString().slice(0, 10);

function freshness(at: Date | null, now: Date): OverviewCard['freshness'] {
  if (!at) return null;
  return now.getTime() - at.getTime() <= FRESH_DAYS * DAY_MS ? 'fresh' : 'stale';
}

function change(
  current: number | null,
  previous: number | null,
  unit: string,
  higherIsBetter: boolean,
): OverviewCard['change'] {
  // prettier-ignore
  if (current === null || previous === null) return null;
  const diff = Math.round((current - previous) * 10) / 10;
  return {
    absolute: `${diff > 0 ? '+' : ''}${fmt(diff)}${unit}`,
    percent: previous !== 0 ? Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10 : null,
    direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
    good: diff === 0 ? null : diff > 0 === higherIsBetter,
  };
}

function card(partial: Partial<OverviewCard> & Pick<OverviewCard, 'key' | 'title' | 'state'>): OverviewCard {
  return { value: null, previous: null, change: null, dateRange: null, place: null, source: null, lastCollectedAt: null, freshness: null, limitations: [], lines: [], action: null, ...partial }; // prettier-ignore
}

export async function buildLocalOverview(
  prisma: PrismaClient,
  projectId: string,
  options: { locationId?: string | null; days?: number; now?: Date } = {},
): Promise<LocalOverviewDto> {
  const now = options.now ?? new Date();
  const days = options.days ?? 28;
  const from = new Date(now.getTime() - days * DAY_MS);
  const prevFrom = new Date(from.getTime() - days * DAY_MS);
  const base = `/app/p/${projectId}`;
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const location = options.locationId
    ? await prisma.businessLocation.findFirst({ where: { id: options.locationId, projectId, archivedAt: null } })
    : await prisma.businessLocation.findFirst({ where: { projectId, archivedAt: null }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] }); // prettier-ignore
  const place = location ? [location.locality, location.city].filter(Boolean).join(', ') : null;
  const cards: OverviewCard[] = [];

  // ---- Local rank grids (Maps / local pack), per query, from the two latest finished scans.
  const queries = location
    ? await prisma.localRankQuery.findMany({
        where: { projectId, locationId: location.id },
        include: { scans: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 2, include: { points: { select: { row: true, col: true, status: true, rank: true, results: true } } } } }, // prettier-ignore
        orderBy: { createdAt: 'asc' },
      })
    : [];
  const scanned = queries.filter((q) => q.scans.length);
  const latestAt = scanned.reduce<Date | null>((m, q) => (!m || q.scans[0]!.createdAt > m ? q.scans[0]!.createdAt : m), null); // prettier-ignore
  const sources = [
    ...new Set(scanned.map((q) => LOCAL_RANK_SOURCE_LABELS[q.scans[0]!.source as LocalRankSource])),
  ];
  if (!location)
    cards.push(card({ key: 'maps', title: 'Google Maps / local pack visibility', state: 'empty', limitations: ['Add a business location to track local rankings.'], action: { label: 'Add a location', to: `${base}/locations` } })); // prettier-ignore
  else if (!scanned.length)
    cards.push(card({ key: 'maps', title: 'Google Maps / local pack visibility', state: 'empty', place, limitations: [queries.length ? 'No finished scan yet.' : 'Track a query such as “best jewellers in your city” on a grid.'], action: { label: 'Open the rank tracker', to: `${base}/local/rank` } })); // prettier-ignore
  else {
    const first = scanned[0]!;
    const [latest, previous] = first.scans;
    cards.push(
      card({
        key: 'maps',
        title: 'Google Maps / local pack visibility',
        state: 'ok',
        value: pct(latest!.top3Share),
        previous: previous ? pct(previous.top3Share) : null,
        change: previous ? change(latest!.top3Share, previous.top3Share, ' pts', true) : null,
        dateRange: `Scan of ${day(latest!.createdAt)}${previous ? ` vs ${day(previous.createdAt)}` : ''}`,
        place,
        source: sources.join('; '),
        lastCollectedAt: latestAt?.toISOString() ?? null,
        freshness: freshness(latestAt, now),
        limitations: [
          'Share of measured grid points where the business is in the top 3 for that query. Failed points are left out; each query and surface is shown separately.', // prettier-ignore
          ...(scanned.length > 1
            ? [`The headline is “${first.query}”; every tracked query is listed below.`]
            : []),
        ],
        lines: scanned.map((q) => ({
          label: `${q.query} (${q.surface === 'MAPS' ? 'Maps' : q.surface === 'LOCAL_PACK' ? 'local pack' : 'organic'})`,
          value: pct(q.scans[0]!.top3Share) ?? '—',
          note: `${q.scans[0]!.pointsMeasured}/${q.scans[0]!.pointsPlanned} points measured${q.scans[1] ? `, previous ${pct(q.scans[1].top3Share) ?? '—'}` : ''}`, // prettier-ignore
        })),
        action: { label: 'Open the rank tracker', to: `${base}/local/rank` },
      }),
    );
  }

  // ---- Local keyword rankings: the rank at the business's own point (grid centre), per query.
  if (scanned.length) {
    const centreRank = (scan: (typeof scanned)[number]['scans'][number]) => {
      const mid = Math.floor(scan.gridSize / 2);
      const p = scan.points.find((pt) => pt.row === mid && pt.col === mid);
      return !p || (p.status !== 'FOUND' && p.status !== 'NOT_FOUND') ? undefined : p.rank;
    };
    cards.push(
      card({
        key: 'local_rankings',
        title: 'Local keyword rankings',
        state: 'ok',
        place: location ? `At the business (${place})` : null,
        source: sources.join('; '),
        lastCollectedAt: latestAt?.toISOString() ?? null,
        freshness: freshness(latestAt, now),
        limitations: ['Position at the grid centre (the business location) in the latest scan. "Not in top N" means not within the checked depth.'], // prettier-ignore
        lines: scanned.map((q) => {
          const r = centreRank(q.scans[0]!);
          const prev = q.scans[1] ? centreRank(q.scans[1]) : undefined;
          return {
            label: q.query,
            value: r === undefined ? 'Not measured' : r === null ? `Not in top ${q.scans[0]!.depth}` : `#${r}`,
            note: prev === undefined ? undefined : `previous ${prev === null ? `not in top ${q.scans[1]!.depth}` : `#${prev}`}`,
          };
        }),
        action: { label: 'Open the rank tracker', to: `${base}/local/rank` },
      }),
    );
  } else cards.push(card({ key: 'local_rankings', title: 'Local keyword rankings', state: 'empty', limitations: ['Appears after the first finished grid scan.'], action: { label: 'Open the rank tracker', to: `${base}/local/rank` } })); // prettier-ignore

  // ---- Organic search: Google Search Console (first-party).
  const gsc = await prisma.integration.findFirst({ where: { projectId, provider: 'GOOGLE_SEARCH_CONSOLE' }, select: { status: true, lastSyncAt: true } }); // prettier-ignore
  if (!project.websiteUrl)
    cards.push(card({ key: 'organic', title: 'Google organic search', state: 'unsupported', limitations: ['Organic search performance needs a website and Search Console. This business has no website.'] })); // prettier-ignore
  else if (gsc?.status !== 'CONNECTED')
    cards.push(card({ key: 'organic', title: 'Google organic search', state: 'connect', limitations: ['Connect Google Search Console to see clicks, impressions and average position.'], action: { label: 'Connect account', to: `${base}/integrations` } })); // prettier-ignore
  else {
    const rows = await prisma.searchConsoleMetric.findMany({ where: { projectId, dimension: 'DATE', rangeStart: { gte: prevFrom, lt: now } }, select: { rangeStart: true, clicks: true, impressions: true, position: true } }); // prettier-ignore
    const sum = (start: Date, end: Date) => {
      const r = rows.filter((x) => x.rangeStart >= start && x.rangeStart < end);
      const impressions = r.reduce((s, x) => s + x.impressions, 0);
      return { days: r.length, clicks: r.reduce((s, x) => s + x.clicks, 0), impressions, position: impressions ? Math.round((r.reduce((s, x) => s + x.position * x.impressions, 0) / impressions) * 10) / 10 : null }; // prettier-ignore
    };
    const cur = sum(from, now);
    const prev = sum(prevFrom, from);
    cards.push(
      card({
        key: 'organic',
        title: 'Google organic search',
        state: cur.days ? 'ok' : 'empty',
        value: cur.days ? `${fmt(cur.clicks)} clicks` : null,
        previous: prev.days ? `${fmt(prev.clicks)} clicks` : null,
        change: cur.days && prev.days ? change(cur.clicks, prev.clicks, '', true) : null,
        dateRange: `Last ${days} days vs the ${days} before`,
        place: 'All countries (Search Console property)',
        source: 'Google Search Console (first-party)',
        lastCollectedAt: gsc.lastSyncAt?.toISOString() ?? null,
        freshness: freshness(gsc.lastSyncAt, now),
        limitations: [
          'Search Console data arrives with a 2–3 day delay. Average position is impression-weighted.',
        ],
        lines: cur.days ? [{ label: 'Impressions', value: fmt(cur.impressions), note: prev.days ? `previous ${fmt(prev.impressions)}` : undefined }, { label: 'Average position', value: cur.position === null ? '—' : String(cur.position), note: prev.position !== null ? `previous ${prev.position}` : undefined }] : [], // prettier-ignore
        action: { label: 'Open Search Console data', to: `${base}/integrations` },
      }),
    );
  }

  // ---- AI answers, one card per AI system; each source (API, licensed provider, manual) is its own line.
  const AI_SOURCES = {
    chatgpt: ['openai_web_search', 'manual_chatgpt'],
    gemini: ['gemini_model_knowledge', 'manual_gemini'],
    ai_mode: ['dataforseo_ai_mode', 'manual_google_ai_mode', 'manual_google_ai_overview'],
  } as const;
  const obs = await prisma.aiVisibilityObservation.findMany({
    where: { projectId, status: 'SUCCEEDED', isDemo: false, observedAt: { gte: prevFrom, lt: now }, provider: { in: Object.values(AI_SOURCES).flat() } }, // prettier-ignore
    select: { provider: true, observedAt: true, brandMentioned: true, brandCited: true, country: true, city: true, captureMethod: true }, // prettier-ignore
  });
  const rate = (provider: string, start: Date, end: Date) => {
    const r = obs.filter((o) => o.provider === provider && o.observedAt >= start && o.observedAt < end);
    return r.length ? { n: r.length, mention: (r.filter((o) => o.brandMentioned).length / r.length) * 100, cited: (r.filter((o) => o.brandCited).length / r.length) * 100 } : null; // prettier-ignore
  };
  const aiCard = (
    key: 'chatgpt' | 'gemini' | 'ai_mode',
    title: string,
    empty: OverviewCard['limitations'],
    unsupported: boolean,
    note: string,
  ): OverviewCard => {
    const sources = AI_SOURCES[key].map((provider) => ({ provider, cur: rate(provider, from, now), prev: rate(provider, prevFrom, from) })); // prettier-ignore
    const head = sources.find((x) => x.cur);
    if (!head)
      return card({ key, title, state: unsupported ? 'unsupported' : 'empty', limitations: empty, action: { label: 'Open AI visibility', to: `${base}/visibility` } }); // prettier-ignore
    const rows = obs.filter((o) => (AI_SOURCES[key] as readonly string[]).includes(o.provider));
    const last = rows.reduce<Date | null>((m, o) => (!m || o.observedAt > m ? o.observedAt : m), null);
    const places = [...new Set(rows.map((o) => [o.city, o.country].filter(Boolean).join(', ')))];
    return card({
      key,
      title,
      state: 'ok',
      value: `${pct(head.cur!.mention)} of answers mention you`,
      previous: head.prev ? pct(head.prev.mention) : null,
      change: head.prev ? change(Math.round(head.cur!.mention * 10) / 10, Math.round(head.prev.mention * 10) / 10, ' pts', true) : null, // prettier-ignore
      dateRange: `Last ${days} days vs the ${days} before`,
      place: places.join('; '),
      source: observationProviderLabel(head.provider),
      lastCollectedAt: last?.toISOString() ?? null,
      freshness: freshness(last, now),
      limitations: [
        'A mention is the business named in an answer; a citation is a link to its website. They are counted separately, and each source is shown on its own line.', // prettier-ignore
        note,
      ],
      lines: sources
        .filter((x) => x.cur)
        .map((x) => ({
          label: observationProviderLabel(x.provider),
          value: `mentioned ${pct(x.cur!.mention)} · cited ${pct(x.cur!.cited)}`,
          note: `${fmt(x.cur!.n)} answers · ${CAPTURE_METHOD_LABELS[captureMethodOfProvider(x.provider)].toLowerCase()}`,
        })),
      action: { label: 'Open AI visibility', to: `${base}/visibility` },
    });
  };
  cards.push(aiCard('ai_mode', 'Google AI Mode / AI Overviews', ['Google offers no API for AI Mode or AI Overviews. Record what you see as a manual observation, or an operator can enable the licensed provider (SERP_PROVIDER=dataforseo).'], true, 'AI Mode and AI Overviews are different Google features and are never combined.')); // prettier-ignore
  cards.push(aiCard('chatgpt', 'ChatGPT visibility', ['Track prompts in AI visibility, or record what ChatGPT showed as a manual observation.'], false, 'OpenAI with web search approximates, but is not, ChatGPT search; manual entries record what a person saw in ChatGPT.')); // prettier-ignore
  cards.push(aiCard('gemini', 'Gemini visibility', ['Needs a Gemini API key (answers without Google Search grounding, the only kind Google’s terms allow storing), or a manual observation of the Gemini app.'], !getEnv().GEMINI_API_KEY, 'The Gemini API answer is the model’s knowledge without live search; manual entries record what a person saw in the Gemini app.')); // prettier-ignore

  // ---- Google Business Profile performance (first-party, reported by Google), for the selected location.
  const profilePage = `${base}/local/profile${location ? `?location=${location.id}` : ''}`;
  const gbp = await prisma.integration.findFirst({ where: { projectId, provider: 'GOOGLE_BUSINESS_PROFILE' }, select: { status: true, lastSyncAt: true } }); // prettier-ignore
  const linked = Boolean(location?.profileLocationName);
  const cutoff = profileRetentionCutoff(now);
  const [profileMetrics, profileSnapshot, unanswered] =
    linked && gbp?.status === 'CONNECTED'
      ? await Promise.all([
          prisma.businessProfileMetric.findMany({ where: { locationId: location!.id, fetchedAt: { gte: cutoff } }, select: { metric: true, date: true, value: true, fetchedAt: true } }), // prettier-ignore
          prisma.businessProfileSnapshot.findFirst({ where: { locationId: location!.id, fetchedAt: { gte: cutoff } }, orderBy: { fetchedAt: 'desc' }, select: { fetchedAt: true, averageRating: true, totalReviewCount: true } }), // prettier-ignore
          prisma.businessReview.count({
            where: { locationId: location!.id, fetchedAt: { gte: cutoff }, replyComment: null },
          }),
        ])
      : [[], null, 0];
  if (!gbp || gbp.status === 'DISCONNECTED' || gbp.status === 'NEEDS_REAUTH')
    cards.push(card({ key: 'business_profile', title: 'Business Profile performance', state: 'connect', limitations: [gbp?.status === 'NEEDS_REAUTH' ? 'Google access expired. Reconnect Business Profile to keep the data current.' : 'Connect Google Business Profile to see views, calls, direction requests and website clicks reported by Google.'], action: { label: gbp?.status === 'NEEDS_REAUTH' ? 'Reconnect' : 'Connect account', to: `${base}/integrations` } })); // prettier-ignore
  else if (!linked)
    cards.push(card({ key: 'business_profile', title: 'Business Profile performance', state: 'empty', place, limitations: [location ? 'Link this location to its Business Profile.' : 'Add a business location first.'], action: { label: 'Link the profile', to: profilePage } })); // prettier-ignore
  else if (!profileMetrics.length)
    cards.push(card({ key: 'business_profile', title: 'Business Profile performance', state: 'empty', place, limitations: ['No metrics yet. Google reports them a few days late; sync the profile to fetch them.'], action: { label: 'Open Business Profile', to: profilePage } })); // prettier-ignore
  else {
    const summary = summarizeProfileMetrics(
      profileMetrics,
      profileSnapshot?.fetchedAt ?? profileMetrics[0]!.fetchedAt,
    );
    const get = (metric: string) => summary.metrics.find((m) => m.metric === metric);
    const views = summary.metrics.filter((m) => m.metric.startsWith('BUSINESS_IMPRESSIONS_'));
    const viewsNow = views.reduce((sum, m) => sum + m.current, 0);
    const viewsBefore = summary.previousRange ? views.reduce((sum, m) => sum + (m.previous ?? 0), 0) : null;
    const line = (metric: string, label: string) => {
      const m = get(metric);
      return { label, value: fmt(m?.current ?? 0), note: m?.previous !== null && m?.previous !== undefined ? `previous ${fmt(m.previous)}` : undefined }; // prettier-ignore
    };
    cards.push(
      card({
        key: 'business_profile',
        title: 'Business Profile performance',
        state: 'ok',
        value: `${fmt(viewsNow)} profile views`,
        previous: viewsBefore === null ? null : `${fmt(viewsBefore)} profile views`,
        change: viewsBefore === null ? null : change(viewsNow, viewsBefore, '', true),
        dateRange: `${summary.range.from} to ${summary.range.to}${summary.previousRange ? ' vs the 28 days before' : ''}`,
        place,
        source: 'Google Business Profile Performance API (first-party)',
        lastCollectedAt: gbp.lastSyncAt?.toISOString() ?? null,
        freshness: freshness(gbp.lastSyncAt, now),
        limitations: ['Views count unique people per day on Google Maps and Search, as Google reports them; they are not rankings. Google reports with a few days’ delay.'], // prettier-ignore
        lines: [line('CALL_CLICKS', 'Calls'), line('BUSINESS_DIRECTION_REQUESTS', 'Direction requests'), line('WEBSITE_CLICKS', 'Website clicks')], // prettier-ignore
        action: { label: 'Open Business Profile', to: profilePage },
      }),
    );
  }

  // ---- Accounts not connected yet in this installation.
  // ---- Merchant Center and product data (Surfaced's checks; Google's statuses when connected).
  const merchantPage = `${base}/local/merchant`;
  const [mc, products, lastImport] = await Promise.all([
    prisma.integration.findFirst({ where: { projectId, provider: 'GOOGLE_MERCHANT_CENTER' }, select: { status: true, lastSyncAt: true, config: true } }), // prettier-ignore
    productSummary(prisma, projectId),
    prisma.productFeedImport.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' }, select: { createdAt: true, fileName: true } }), // prettier-ignore
  ]);
  const mcAccount = mc?.status === 'CONNECTED' ? (mc.config as { account?: MerchantAccountSnapshot } | null)?.account ?? null : null; // prettier-ignore
  const productsAt = [mc?.status === 'CONNECTED' ? mc.lastSyncAt : null, lastImport?.createdAt ?? null].filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null; // prettier-ignore
  const productSource = [products.bySource.MERCHANT_API ? 'Google Merchant Center (first-party)' : null, products.bySource.FEED_IMPORT ? `Product feed file${lastImport ? ` (${lastImport.fileName})` : ''}` : null].filter(Boolean).join('; '); // prettier-ignore
  if (!products.total && !mcAccount)
    cards.push(card({ key: 'merchant', title: 'Google Merchant Center & Shopping', state: 'connect', limitations: ['Connect Merchant Center or import a product feed to see which products can appear in free listings, Shopping ads and local listings.'], action: { label: 'Set up products', to: merchantPage } })); // prettier-ignore
  else
    cards.push(
      card({
        key: 'merchant',
        title: 'Google Merchant Center & Shopping',
        state: 'ok',
        value: mcAccount?.freeListings ? `Free listings ${mcAccount.freeListings.state === 'ENABLED' ? 'on' : mcAccount.freeListings.state === 'ELIGIBLE' ? 'eligible, not on' : 'not eligible'}` : `${fmt(products.total)} products`, // prettier-ignore
        source: mcAccount ? 'Google Merchant Center (first-party)' : productSource,
        lastCollectedAt: productsAt?.toISOString() ?? null,
        freshness: freshness(productsAt, now),
        limitations: mcAccount ? ['Program status and account issues as Merchant Center reports them. Performance (clicks, impressions) is not read yet.'] : ['From an imported feed file: Google’s own approval status needs a connected Merchant Center account.'], // prettier-ignore
        lines: [
          { label: 'Products', value: fmt(products.total) },
          ...(mcAccount ? [{ label: 'Account issues', value: fmt(mcAccount.issues.length) }, { label: 'Website claimed', value: mcAccount.homepage?.claimed ? 'Yes' : mcAccount.homepage ? 'No' : '—' }] : []), // prettier-ignore
        ],
        action: { label: 'Open Merchant Center', to: merchantPage },
      }),
    );
  if (!products.total)
    cards.push(card({ key: 'product_health', title: 'Product listing health', state: 'empty', limitations: ['Appears once products are imported from a feed or read from Merchant Center.'], action: { label: 'Import a product feed', to: merchantPage } })); // prettier-ignore
  else
    cards.push(
      card({
        key: 'product_health',
        title: 'Product listing health',
        state: 'ok',
        value: `${fmt(products.ok)} of ${fmt(products.total)} pass all checks`,
        source: productSource,
        lastCollectedAt: productsAt?.toISOString() ?? null,
        freshness: freshness(productsAt, now),
        limitations: ['Errors are likely to block a listing; warnings limit it. Surfaced’s checks follow Google’s product data specification, and Google decides; issues reported by Google are counted too.'], // prettier-ignore
        lines: [
          { label: 'Likely blocked in free listings', value: fmt(products.blockedByProgram.FREE_LISTINGS) },
          { label: 'Likely blocked in Shopping ads', value: fmt(products.blockedByProgram.SHOPPING_ADS) },
          {
            label: 'Likely blocked in local listings',
            value: fmt(products.blockedByProgram.FREE_LOCAL_LISTINGS),
          },
          ...products.topIssues
            .slice(0, 2)
            .map((i) => ({ label: i.message, value: `${fmt(i.products)} products`, note: i.severity })),
        ],
        action: { label: products.errors ? 'Fix product errors' : 'Open products', to: merchantPage },
      }),
    );

  // ---- Competitors and public reviews from the latest scans.
  const latestScans = scanned.map((q) => q.scans[0]!);
  const listed = new Map<
    string,
    { name: string; top3: number; rating: number | null; reviews: number | null }
  >();
  let own = null as { rating: number | null; reviews: number | null } | null;
  for (const scan of latestScans)
    for (const point of scan.points) {
      if (point.status !== 'FOUND' && point.status !== 'NOT_FOUND') continue;
      for (const r of (Array.isArray(point.results) ? point.results : []) as unknown as LocalResult[]) {
        if (r.isTarget) {
          own = { rating: r.rating ?? own?.rating ?? null, reviews: r.reviewCount ?? own?.reviews ?? null };
          continue;
        }
        const key = r.placeId ?? r.title;
        const entry = listed.get(key) ?? { name: r.title, top3: 0, rating: r.rating, reviews: r.reviewCount };
        if (r.rank <= 3) entry.top3 += 1;
        listed.set(key, entry);
      }
    }
  const suggested = await prisma.projectCompetitor.count({
    where: { projectId, kind: 'LOCAL', status: 'SUGGESTED' },
  });
  const top = [...listed.values()].sort((a, b) => b.top3 - a.top3).slice(0, 5);
  cards.push(
    top.length
      ? card({ key: 'competitors', title: 'Competitor visibility', state: 'ok', value: `${top[0]!.name}`, place, source: sources.join('; '), lastCollectedAt: latestAt?.toISOString() ?? null, freshness: freshness(latestAt, now), limitations: ['Businesses listed most often in the top 3 across the latest scans (measured points only).'], lines: top.map((t) => ({ label: t.name, value: `${t.top3} top-3 points`, note: t.rating !== null ? `${t.rating}★ (${t.reviews ?? '—'} reviews, public)` : undefined })), action: { label: suggested ? `Review ${suggested} suggested competitors` : 'Compare competitors', to: `${base}/local/rank` } }) // prettier-ignore
      : card({ key: 'competitors', title: 'Competitor visibility', state: 'empty', limitations: ['Appears after the first grid scan.'] }), // prettier-ignore
  );
  cards.push(
    profileSnapshot && profileSnapshot.averageRating !== null
      ? card({ key: 'reviews', title: 'Review performance', state: 'ok', value: `${Number(profileSnapshot.averageRating)}★`, place, source: 'Google Business Profile (as reported by Google)', lastCollectedAt: profileSnapshot.fetchedAt.toISOString(), freshness: freshness(profileSnapshot.fetchedAt, now), lines: [{ label: 'Reviews', value: profileSnapshot.totalReviewCount === null ? '—' : fmt(profileSnapshot.totalReviewCount) }, { label: 'Recent reviews without a reply', value: fmt(unanswered) }], limitations: ['Average rating and count as Google reports them for the profile.'], action: { label: unanswered ? 'Reply to reviews' : 'Open reviews', to: profilePage } }) // prettier-ignore
      : own && own.rating !== null
      ? card({ key: 'reviews', title: 'Review performance', state: 'ok', value: `${own.rating}★`, place, source: `Publicly displayed in Google results (${sources.join('; ')})`, lastCollectedAt: latestAt?.toISOString() ?? null, freshness: freshness(latestAt, now), lines: [{ label: 'Reviews shown', value: own.reviews === null ? '—' : fmt(own.reviews) }], limitations: ['Rating and count as displayed in the latest scan. Review text, replies and trends need a connected Business Profile.'] }) // prettier-ignore
      : card({ key: 'reviews', title: 'Review performance', state: 'connect', limitations: ['Connect Business Profile for reviews and replies; public ratings appear here after a scan finds the business.'], action: { label: 'Open Business Profile', to: profilePage } }), // prettier-ignore
  );

  // ---- Health and recommendations.
  const health = await computeLocalHealth(prisma, project, location, products, now);
  cards.push(
    health.score === null
      ? card({ key: 'local_health', title: 'Local SEO health score', state: 'empty', limitations: ['Add a business location to calculate it.'], action: { label: 'Add a location', to: `${base}/locations` } }) // prettier-ignore
      : card({
          key: 'local_health',
          title: 'Local SEO health score',
          state: 'ok',
          value: `${health.score} / 100`,
          place,
          source: `${health.measured} of ${health.components.length} parts measured`,
          limitations: [
            'Built from what the business controls. Parts without data are left out and the others are re-weighted; Maps and AI visibility are results, shown on their own cards. A good score does not guarantee rankings.', // prettier-ignore
            ...health.components.filter((c) => c.score !== null).map((c) => `${c.label}: ${c.evidence}`),
          ],
          lines: health.components.map((c) => ({ label: `${c.label} (weight ${c.weight})`, value: c.score === null ? 'Not measured' : `${c.score} / 100`, note: c.score === null ? c.evidence : (c.source ?? undefined) })), // prettier-ignore
          action: { label: 'Open Business Profile audit', to: profilePage },
        }),
  );
  const open = await prisma.recommendation.count({ where: { projectId, status: { in: [...RECOMMENDATION_OPEN_STATUSES] } } }); // prettier-ignore
  cards.push(card({ key: 'recommendations', title: 'Outstanding recommendations', state: 'ok', value: fmt(open), source: 'OptiReach recommendations', limitations: [], action: { label: 'Open recommendations', to: `${base}/recommendations` } })); // prettier-ignore

  // ---- Setup steps, in the order that gets data onto the most cards first.
  const env = getEnv();
  const [finishedScans, aiAnswers, manualGoogle] = await Promise.all([
    prisma.localRankScan.count({ where: { projectId, status: 'SUCCEEDED' } }),
    prisma.aiVisibilityObservation.count({ where: { projectId, status: 'SUCCEEDED', isDemo: false, provider: { notIn: ['manual_google_ai_mode', 'manual_google_ai_overview', 'dataforseo_ai_mode'] } } }), // prettier-ignore
    prisma.aiVisibilityObservation.count({ where: { projectId, status: 'SUCCEEDED', provider: { in: ['manual_google_ai_mode', 'manual_google_ai_overview', 'dataforseo_ai_mode'] } } }), // prettier-ignore
  ]);
  const businessTypes = ((project.businessProfile as { types?: string[] } | null)?.types ?? []) as string[];
  const hasCoordinates = Boolean(location && location.latitude !== null && location.longitude !== null);
  const missingDetails = location
    ? [!location.phone && 'phone number', !(Array.isArray(location.openingHours) && location.openingHours.length) && 'opening hours', !location.primaryCategory && 'main category'].filter((x): x is string => Boolean(x)) // prettier-ignore
    : [];
  const rankSource =
    env.SERP_PROVIDER === 'custom' && env.CUSTOM_SERP_URL
      ? 'Click “Scan now”: your own collection service (CUSTOM_SERP_URL) checks every grid point, and results are stored in the order it returns them.'
      : env.SERP_PROVIDER === 'osm'
        ? 'Click “Scan now”: OpenStreetMap lists the businesses mapped near each point (distance-ordered discovery, not a Google Maps ranking). For Google’s actual order, “Record manually” and enter what Google Maps shows.'
        : env.LOCAL_RANK_FIXTURES
          ? 'No collection source is set up: click “Scan now” for sample data (labeled “Development fixture”, development only), or “Record manually” and enter what Google Maps shows at each point.'
          : 'No collection source is set up: click “Record manually” and enter what Google Maps shows at each point (a 1×1 or 3×3 grid is quickest). Enable OpenStreetMap discovery (SERP_PROVIDER=osm) or your own service (SERP_PROVIDER=custom) in .env for automatic scans.';
  const setup: LocalOverviewDto['setup'] = [
    {
      key: 'location',
      title: location ? `Add the map position of ${location.name}` : 'Add your shop’s location',
      detail: location
        ? 'The location is saved, but its map position (latitude and longitude) is empty, and rank grids are drawn around it. Edit the location, then click “Fill from link” with your Google listing’s Share link, or “Find from address” and drag the pin onto the shop.'
        : 'Add the address customers visit (or the areas you serve).',
      status: hasCoordinates ? 'done' : 'todo',
      fills: ['Google Maps / local pack visibility', 'Local keyword rankings', 'Competitor visibility'],
      action: { label: location ? 'Edit the location' : 'Add a location', to: `${base}/locations` },
    },
    {
      key: 'details',
      title: 'Complete the shop’s details',
      detail: missingDetails.length ? `Missing: ${missingDetails.join(', ')}. These count towards the health score and are what customers see first.` : 'Phone, opening hours and category are filled in.', // prettier-ignore
      status: location && !missingDetails.length ? 'done' : 'todo',
      fills: ['Local SEO health score'],
      action: { label: 'Edit the location', to: `${base}/locations` },
    },
    {
      key: 'rank',
      title: 'Track your first local search on the map grid',
      detail: `Add a search customers type, such as “jewellers in ${location?.city ?? 'your city'}”, then run a scan. ${rankSource}`,
      status: finishedScans ? 'done' : 'todo',
      fills: [
        'Google Maps / local pack visibility',
        'Local keyword rankings',
        'Competitor visibility',
        'Review performance',
      ],
      action: { label: 'Open the rank tracker', to: `${base}/local/rank` },
    },
    {
      key: 'ai',
      title: 'Ask AI assistants about your business',
      detail: env.OPENAI_API_KEY
        ? `OpenAI with web search is set up. Add a prompt such as “best jewellers in ${location?.city ?? 'your city'}” with the city filled in, choose “OpenAI · web search” and run it (each run is billed to the OpenAI key).`
        : 'No AI provider key is set up here; you can still record answers by hand (next step), or use the labeled demo provider to see how it works.',
      status: aiAnswers ? 'done' : 'todo',
      fills: ['ChatGPT visibility', 'Gemini visibility'],
      action: { label: 'Open AI visibility', to: `${base}/visibility?tab=prompts` },
    },
    {
      key: 'ai_mode',
      title: 'Record what Google AI Mode shows',
      detail:
        'Google has no API for AI Mode or AI Overviews. Search your prompt on Google (AI Mode tab), then on the Observations tab choose “Record what an AI showed” and paste the answer and its source links. It needs a prompt first.',
      status: manualGoogle ? 'done' : 'todo',
      fills: ['Google AI Mode / AI Overviews'],
      action: { label: 'Open observations', to: `${base}/visibility?tab=observations` },
    },
    ...(businessTypes.includes('MERCHANT_SELLER') || businessTypes.includes('ECOMMERCE') || products.total
      ? [{
          key: 'products',
          title: 'Import your product feed',
          detail: 'Upload a CSV or TSV in Google’s product format, or a Shopify product export. Each product is checked for free listings, Shopping ads and local listings before anything is saved.',
          status: products.total ? 'done' : 'todo',
          fills: ['Google Merchant Center & Shopping', 'Product listing health', 'Local SEO health score'],
          action: { label: 'Open Merchant Center', to: merchantPage },
        } as LocalOverviewDto['setup'][number]] // prettier-ignore
      : []),
    {
      key: 'business_profile',
      title: 'Connect Google Business Profile',
      detail:
        !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET
          ? 'Needs a Google OAuth client and Google’s approval of Business Profile API access, set up by whoever runs this installation (see docs/integrations.md). Until then, the profile audit uses the details entered here.'
          : 'Connect the Google account that manages the profile, then link this location to it.',
      status: location?.profileLocationName
        ? 'done'
        : !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET
          ? 'admin'
          : 'todo',
      fills: ['Business Profile performance', 'Review performance'],
      action: { label: 'Open Business Profile', to: profilePage },
    },
    ...(!project.websiteUrl
      ? [{
          key: 'website',
          title: 'Add your website (optional)',
          detail: 'A website adds website audits, organic search data from Search Console, and links to your site in AI answers.',
          status: 'optional',
          fills: ['Google organic search'],
          action: { label: 'Open project settings', to: `${base}/settings` },
        } as LocalOverviewDto['setup'][number]] // prettier-ignore
      : []),
  ];

  return {
    generatedAt: now.toISOString(),
    days,
    location: location ? { id: location.id, name: location.name, city: location.city } : null,
    hasWebsite: Boolean(project.websiteUrl),
    cards,
    setup,
  };
}
