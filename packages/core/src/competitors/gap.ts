// Competitor gap analysis: why AI answers recommend other brands, and what the project can genuinely do about it.
//
// Evidence, in order of trust:
//  1. Stored AI visibility observations: answer text, mention matching and cited URLs (observed facts).
//  2. Optional AI extraction of the brands each answer recommends and the reasons it gives. Every brand name and
//     every quoted reason is checked to appear word for word in the stored answer; anything else is dropped.
//  3. The project's latest crawl and audit, and live checks of public pages (robots.txt respected, SSRF-safe).
// Actions are built by fixed rules from that evidence. Nothing is estimated, and no outcome is promised.
import {
  AI_CRAWLERS,
  brandKey,
  getAuditRule,
  isSameOrSubdomain,
  type GapAction,
  type GapAnalysisResult,
  type GapAttribute,
  type GapBrand,
  type GapCrawlerAccess,
  type GapPageCheck,
  type GapPrompt,
  type GapQuote,
  type GapReadiness,
  type GapSource,
  type GapSourceType,
} from '@surfaced/shared';
import robotsParser from 'robots-parser';
import { z } from 'zod';
import { getLlmProvider, type LlmProvider } from '../ai';
import { recordProviderUsage } from '../costs';
import { SafeFetcher, type SafeFetcherOptions } from '../crawler';
import type { Prisma, PrismaClient } from '../db';
import { errorMessage } from '../errors';
import { requireWebsite } from '../website';
import { upsertEvidenceRecommendation } from '../recommendations/evidence';
import { checkPage, comparableUrl } from '../verify';
import { inPool } from './pool';

const WINDOW_DAYS = 90;
const MAX_ANSWERS = 2000;
const MAX_EXTRACTED_ANSWERS = 120;
const EXTRACTION_BATCH = 6;
const MAX_ANSWER_CHARS = 6000;
const MAX_PAGE_CHECKS = 12;
const MAX_QUOTES = 3;

// ---------------- Domains and sources ----------------

const MULTI_PART_SUFFIXES = new Set([
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'gov.in',
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za',
  'com.br', 'com.mx', 'co.jp', 'com.sg', 'com.my', 'com.ph', 'com.pk', 'com.bd', 'com.np',
  'com.lk', 'co.id', 'com.tr', 'com.cn', 'com.hk', 'com.tw', 'co.kr', 'com.sa', 'com.eg',
  'com.ng', 'co.ke', 'ae.org', 'com.ar', 'com.co',
]); // prettier-ignore

/** "content-files.canva.com" → "canva.com"; "shop.example.co.in" → "example.co.in" (common suffixes only). */
export function registrableDomain(domain: string): string {
  const labels = domain
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.$/, '')
    .split('.')
    .filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return (MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3) : labels.slice(-2)).join('.');
}

/** The name part of a domain: "einvit.in" → "einvit". */
export function domainLabel(domain: string): string {
  return registrableDomain(domain).split('.')[0] ?? domain;
}

const PLATFORMS: [GapSourceType, string[]][] = [
  ['APP_STORE', ['play.google.com', 'apps.apple.com', 'itunes.apple.com', 'apps.microsoft.com', 'appgallery.huawei.com']],
  ['VIDEO', ['youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com']],
  ['SOCIAL', ['facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'linkedin.com', 'pinterest.com', 'threads.net', 'tiktok.com']],
  ['COMMUNITY', ['reddit.com', 'quora.com', 'stackexchange.com', 'stackoverflow.com', 'news.ycombinator.com']],
  ['PRESS_RELEASE', ['issuewire.com', 'prnewswire.com', 'businesswire.com', 'globenewswire.com', 'einpresswire.com', 'prlog.org', 'openpr.com', 'prweb.com', 'accesswire.com', 'newswire.com', '24-7pressrelease.com']],
  ['REVIEW_DIRECTORY', ['g2.com', 'capterra.com', 'trustpilot.com', 'getapp.com', 'softwareadvice.com', 'producthunt.com', 'alternativeto.net', 'saasworthy.com', 'justdial.com', 'sulekha.com', 'indiamart.com', 'yelp.com', 'tripadvisor.com', 'mouthshut.com', 'sitejabber.com', 'crunchbase.com']],
]; // prettier-ignore

const FILE_HOSTS = [
  'wsimg.com', 'website-files.com', 'cloudfront.net', 'googleusercontent.com', 'amazonaws.com', 'ctfassets.net',
  'imgix.net', 'akamaized.net', 'cloudinary.com', 'wixstatic.com', 'squarespace-cdn.com', 'shopifycdn.com',
]; // prettier-ignore

/** Ratings and download counts quoted from app stores: "4.8 rating", "rated 4.5", "1M+ downloads", "10k reviews". */
const STORE_FIGURE =
  /\b\d(?:\.\d)?\s*(?:\/\s*5|stars?|ratings?)\b|\brated\s+\d|\b\d[\d.,]*\s*(?:k|m|l|lakh|million|cr|crore)?\+?\s*(?:downloads|installs|reviews|ratings)\b/i;
const NON_HTML_PATH = /\.(pdf|docx?|xlsx?|pptx?|jpe?g|png|gif|webp|svg|mp4|zip)$/i;
const COMPARISON_PATH = /(best|top-?\d*|\bvs\b|-vs-|versus|alternative|compar|guide)/i;
const ARTICLE_PATH =
  /(best|top-?\d*|\bvs\b|-vs-|versus|alternative|compar|review|guide|list|blog|article|news|how-to|apps?-for|tools?-for|ideas)/i;

function platformType(domain: string): GapSourceType | null {
  for (const [type, hosts] of PLATFORMS) if (hosts.some((h) => isSameOrSubdomain(domain, h))) return type;
  return null;
}

function isFileHost(domain: string): boolean {
  if (FILE_HOSTS.some((h) => isSameOrSubdomain(domain, h))) return true;
  const first = domain.split('.')[0] ?? '';
  return (
    domain.split('.').length > 2 &&
    /^(img\d*|images?|cdn\d*|assets?|static|files?|media|uploads?)$|files$/.test(first)
  );
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

// ---------------- Answer text ----------------

/** Answer text without Markdown emphasis, links or list markers, with whitespace collapsed. */
export function plainAnswer(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]{1,3}/g, '')
    .replace(/^\s{0,3}(#{1,6}|[-+]|\d+[.)])\s+/gm, '')
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"');
}

function normalizeForMatch(text: string): string {
  return plainAnswer(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordRegex(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term.trim())}(?![\\p{L}\\p{N}])`, 'iu');
}

/** True when `term` occurs as whole words in `text` (case-insensitive). */
function containsTerm(text: string, term: string): boolean {
  return term.trim().length >= 2 && wordRegex(term).test(text);
}

/**
 * The spelling of a brand in `text` whose letters and digits equal `key`, spread over at most three words joined
 * by spaces or hyphens: "Crafty Art" for "craftyart". Returns null when there is none.
 */
export function findSpelling(text: string, key: string): string | null {
  if (key.length < 3) return null;
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  for (let i = 0; i < words.length; i++) {
    let compact = '';
    for (let j = i; j < Math.min(words.length, i + 3); j++) {
      const word = words[j]!;
      if (j > i) {
        const gap = text.slice(words[j - 1]!.index! + words[j - 1]![0].length, word.index!);
        if (!/^[ -]?$/.test(gap)) break;
      }
      compact += word[0].normalize('NFKD').toLowerCase();
      if (compact.length > key.length || !key.startsWith(compact)) break;
      if (compact === key) return text.slice(words[i]!.index!, word.index! + word[0].length);
    }
  }
  return null;
}

/** Sentences of an answer (plain text), each between 20 and 400 characters. */
function sentences(text: string): string[] {
  return plainAnswer(text)
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(])/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 20)
    .map((s) => (s.length > 400 ? `${s.slice(0, 397)}…` : s));
}

// ---------------- Words for page matching ----------------

const STOPWORDS = new Set(
  (
    'a an the and or but if of in on at to for from by with without about into over under as is are was were be ' +
    'been being do does did can could should would will shall may might must i me my we our you your they them ' +
    'their it its this that these those there here what which who whom whose how where when why best top good ' +
    'great better online website websites site sites app apps tool tools make making create creating find get buy ' +
    'near free use using some any all more most other than very also just like vs'
  ).split(' '),
);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Significant, lightly stemmed words of a phrase. */
export function contentWords(text: string): string[] {
  return [...new Set(contentTokens(text))];
}

/** Significant, lightly stemmed words of a text in their original order (repeats kept), for phrase matching. */
export function contentTokens(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem);
  return words.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

// ---------------- AI extraction ----------------

const extractionSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      brands: z.array(
        z.object({
          name: z.string(),
          reasons: z.array(z.object({ attribute: z.string(), quote: z.string() })),
        }),
      ),
    }),
  ),
});

const EXTRACTION_SYSTEM = `You analyse answers that an AI assistant gave to people looking for a product or service.
For each answer, list the brands, products, companies, apps or websites that the answer recommends or presents as options.
Rules:
- Write each name exactly as it appears in the answer. Include only names that appear in the answer text; never add brands the answer does not name.
- Give every brand as its own entry. Never join names with "/" or "or", and never add descriptive words such as "tools" or "sites" to a name. Skip descriptions that are not names (for example "Indian wedding invite sites").
- Exclude generic terms, features, file formats and channels that are only used to share or communicate (for example WhatsApp, email, Instagram, Google Play, App Store), unless the answer recommends them as the solution itself. Exclude the assistant itself.
- For each brand give up to 4 reasons the answer gives for it. "attribute" is a short lower-case label of 2 to 5 words, such as "whatsapp sharing", "rsvp tracking", "hindi templates" or "free plan". "quote" is copied word for word from the answer, at most 25 words, and supports the attribute.
- If an answer recommends no brand, return an empty brand list for it.
Return exactly one entry per answer id.`;

const NOT_BRANDS = new Set(
  [
    'whatsapp', 'email', 'gmail', 'instagram', 'facebook', 'google', 'googleplay', 'playstore', 'appstore',
    'android', 'iphone', 'ios', 'pdf', 'png', 'jpeg', 'jpg', 'mp4', 'chatgpt', 'openai', 'gpt', 'ai', 'qr', 'qrcode',
    'rsvp', 'upi', 'sms',
  ].map(brandKey),
); // prettier-ignore

export interface ExtractedBrand {
  name: string;
  reasons: { attribute: string; quote: string }[];
}

function cleanAttribute(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/+\- ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/**
 * Keeps only brands whose name appears in the answer and reasons whose quote appears word for word
 * (ignoring Markdown, case and spacing). This is what makes AI extraction safe to show as evidence.
 */
export function validateExtraction(answerText: string, brands: ExtractedBrand[]): ExtractedBrand[] {
  const answer = normalizeForMatch(answerText);
  const seen = new Set<string>();
  const kept: ExtractedBrand[] = [];
  for (const brand of brands) {
    const reasons: ExtractedBrand['reasons'] = [];
    for (const reason of brand.reasons.slice(0, 4)) {
      const attribute = cleanAttribute(reason.attribute);
      const quote = normalizeForMatch(reason.quote).replace(/^[\s.,;:!?…-]+|[\s.,;:!?…-]+$/g, '');
      if (attribute.length < 2 || quote.length < 3 || !answer.includes(quote)) continue;
      reasons.push({ attribute, quote: plainAnswer(reason.quote).replace(/\s+/g, ' ').trim() });
    }
    // "WeddingBazaar / WedMeGood tools" → "WeddingBazaar" and "WedMeGood".
    for (const part of plainAnswer(brand.name).split(/\s+\/\s+|\s*\/\s*(?=\p{Lu})|\s+or\s+/u)) {
      const name = part.replace(/\s+/g, ' ').trim().replace(GENERIC_SUFFIX, '').trim();
      const key = brandKey(name);
      if (name.length < 2 || name.length > 60 || key.length < 2 || NOT_BRANDS.has(key) || seen.has(key))
        continue;
      // Descriptions rather than names: three or more words that continue in lower case.
      const words = name.split(' ');
      if (words.length >= 3 && words.slice(1).every((w) => !/\p{Lu}|\p{N}/u.test(w))) continue;
      if (!containsTerm(answer, name.toLowerCase())) continue;
      seen.add(key);
      kept.push({ name, reasons });
    }
  }
  return kept;
}

const GENERIC_SUFFIX = /\s+(tools?|apps?|sites?|websites?|platforms?|options?|makers?|services?)$/i;

interface ExtractionOutcome {
  byObservation: Map<string, ExtractedBrand[]>;
  model: string | null;
  failures: string[];
}

async function extractBrands(
  prisma: PrismaClient,
  llm: LlmProvider,
  answers: { id: string; prompt: string; text: string }[],
  usage: {
    workspaceId: string;
    projectId: string;
    analysisId: string;
    runStartedAt: number;
    backgroundJobId?: string;
  },
): Promise<ExtractionOutcome> {
  const outcome: ExtractionOutcome = { byObservation: new Map(), model: null, failures: [] };
  for (let start = 0, batch = 0; start < answers.length; start += EXTRACTION_BATCH, batch++) {
    const chunk = answers.slice(start, start + EXTRACTION_BATCH);
    const user = chunk
      .map(
        (a) =>
          `Answer id: ${a.id}\nQuestion: ${a.prompt}\nAnswer:\n${a.text.slice(0, MAX_ANSWER_CHARS)}\n---`,
      )
      .join('\n');
    try {
      const result = await llm.generateJson({
        schema: extractionSchema,
        schemaName: 'recommended_brands',
        system: EXTRACTION_SYSTEM,
        user,
        maxOutputTokens: 4000,
      });
      outcome.model = result.model;
      for (const entry of result.data.answers) {
        const answer = chunk.find((a) => a.id === entry.id);
        if (answer) outcome.byObservation.set(answer.id, validateExtraction(answer.text, entry.brands));
      }
      await recordProviderUsage(prisma, {
        workspaceId: usage.workspaceId,
        projectId: usage.projectId,
        provider: result.provider,
        operation: 'gap_analysis',
        model: result.model,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        backgroundJobId: usage.backgroundJobId,
        // Unique per execution: a retried analysis makes new provider calls, which cost again.
        idempotencyKey: `gap:${usage.analysisId}:${usage.runStartedAt}:${batch}`,
      });
    } catch (error) {
      outcome.failures.push(errorMessage(error).slice(0, 200));
      if (outcome.failures.length >= 2) break; // configuration or quota problems: stop calling the provider
    }
  }
  return outcome;
}

// ---------------- Live checks ----------------

async function checkRobots(fetcher: SafeFetcher, homepage: string): Promise<GapReadiness['robots']> {
  const origin = new URL(homepage).origin;
  const url = `${origin}/robots.txt`;
  const agents = (allowed: (agent: string) => boolean | null): GapCrawlerAccess[] =>
    AI_CRAWLERS.map((c) => ({ ...c, allowed: allowed(c.agent) }));
  const result = await fetcher.fetch(url, { accept: 'text/plain,*/*;q=0.5', maxBodyBytes: 512 * 1024 });
  if (result.error || result.statusCode === null || result.statusCode >= 500)
    return {
      url,
      status: 'unreachable',
      httpStatus: result.statusCode,
      error: result.error?.message ?? `HTTP ${result.statusCode}`,
      // RFC 9309: crawlers treat an unreachable robots.txt as "disallow everything".
      agents: agents(() => false),
    };
  if (result.statusCode >= 400)
    return { url, status: 'missing', httpStatus: result.statusCode, error: null, agents: agents(() => true) };
  const robots = robotsParser(url, result.body?.toString('utf8') ?? '');
  return {
    url,
    status: 'ok',
    httpStatus: result.statusCode,
    error: null,
    agents: agents((agent) => robots.isAllowed(homepage, agent) ?? null),
  };
}

// ---------------- Analysis ----------------

interface EntityState {
  brand: GapBrand;
  terms: string[];
  observationIds: Set<string>;
  citedObservationIds: Set<string>;
  promptIds: Set<string>;
  variants: Map<string, number>;
  reasons: Map<string, { answers: Set<string>; quotes: GapQuote[] }>;
}

export interface GapAnalysisOptions {
  fetcherOptions?: SafeFetcherOptions;
  /** Replaces the network fetcher (tests). */
  fetcher?: SafeFetcher;
  /** null disables AI extraction; undefined uses the configured provider. */
  llm?: LlmProvider | null;
  /** false skips network checks (robots.txt, homepage, cited pages). */
  liveChecks?: boolean;
  backgroundJobId?: string;
  now?: Date;
  onProgress?: (percent: number, message: string) => Promise<void>;
}

const READINESS_RULES = [
  'robots-txt-unreachable',
  'page-noindex',
  'organization-schema-missing',
  'structured-data-none',
  'aeo-no-question-headings',
  'thin-content',
  'title-missing',
  'meta-description-missing',
  'canonical-points-elsewhere',
  'sitemap-missing',
];

export async function buildGapAnalysis(
  prisma: PrismaClient,
  projectId: string,
  analysisId: string,
  options: GapAnalysisOptions = {},
): Promise<GapAnalysisResult> {
  const progress = options.onProgress ?? (async () => {});
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000);
  const project = requireWebsite(
    await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      include: { competitors: { where: { status: 'CONFIRMED' }, orderBy: { createdAt: 'asc' } } },
    }),
    'Competitor gap analysis',
  );
  const notes: string[] = [];

  const rows = await prisma.aiVisibilityObservation.findMany({
    where: { projectId, status: 'SUCCEEDED', observedAt: { gte: from, lte: now } },
    orderBy: { observedAt: 'desc' },
    take: MAX_ANSWERS,
    select: {
      id: true,
      promptId: true,
      promptText: true,
      provider: true,
      observedAt: true,
      isDemo: true,
      answerText: true,
      brandMentioned: true,
      brandCited: true,
      mentions: { select: { entityType: true, competitorId: true } },
      citations: {
        select: { url: true, domain: true, title: true, isOwnedDomain: true, competitorId: true },
      },
    },
  });
  const demoAnswersExcluded = rows.filter((r) => r.isDemo).length;
  const answers = rows.filter((r) => !r.isDemo && r.answerText);
  if (rows.length === MAX_ANSWERS) notes.push(`Only the most recent ${MAX_ANSWERS} answers were analyzed.`);
  if (demoAnswersExcluded)
    notes.push(`${demoAnswersExcluded} demo answers were left out: they are fixtures, not real AI output.`);
  const quoteOf = (o: (typeof answers)[number], text: string): GapQuote => ({
    observationId: o.id,
    promptId: o.promptId,
    prompt: o.promptText,
    provider: o.provider,
    observedAt: o.observedAt.toISOString(),
    text,
  });

  // ---- Entities: your brand and tracked competitors (stored mention matching).
  const aliasesOf = (value: unknown) =>
    Array.isArray(value) ? value.filter((a): a is string => typeof a === 'string') : [];
  const newEntity = (brand: Omit<GapBrand, 'answers' | 'mentionRate' | 'citedAnswers' | 'promptIds' | 'reasons' | 'quotes' | 'aliasSuggestion'>, terms: string[]): EntityState => ({
    brand: { ...brand, answers: 0, mentionRate: 0, citedAnswers: 0, promptIds: [], reasons: [], quotes: [], aliasSuggestion: null },
    terms: terms.filter((t) => t.trim().length >= 2),
    observationIds: new Set(),
    citedObservationIds: new Set(),
    promptIds: new Set(),
    variants: new Map(),
    reasons: new Map(),
  }); // prettier-ignore
  const you = newEntity(
    {
      name: project.name,
      key: brandKey(project.name),
      isYou: true,
      competitorId: null,
      tracked: true,
      domain: project.domain,
      detection: 'tracked',
    },
    [project.name, ...aliasesOf(project.brandAliases), project.domain],
  );
  const entities = new Map<string, EntityState>([[you.brand.key, you]]);
  const byCompetitor = new Map<string, EntityState>();
  for (const c of project.competitors) {
    const entity = newEntity(
      { name: c.name, key: brandKey(c.name), isYou: false, competitorId: c.id, tracked: true, domain: c.domain, detection: 'tracked' },
      [c.name, ...aliasesOf(c.aliases), ...(c.domain ? [c.domain] : [])],
    ); // prettier-ignore
    if (entities.has(entity.brand.key)) continue;
    entities.set(entity.brand.key, entity);
    byCompetitor.set(c.id, entity);
  }
  /** Tracked entity that a name or domain label refers to (name, alias or domain label). */
  const trackedFor = (key: string): EntityState | null => {
    for (const entity of [you, ...byCompetitor.values()]) {
      if (entity.brand.key === key) return entity;
      if (entity.terms.some((t) => brandKey(t) === key)) return entity;
      if (entity.brand.domain && brandKey(domainLabel(entity.brand.domain)) === key) return entity;
    }
    return null;
  };

  const record = (entity: EntityState, o: (typeof answers)[number], spelling: string | null) => {
    entity.observationIds.add(o.id);
    entity.promptIds.add(o.promptId);
    if (spelling) entity.variants.set(spelling, (entity.variants.get(spelling) ?? 0) + 1);
  };

  for (const o of answers) {
    if (o.brandMentioned) record(you, o, null);
    if (o.brandCited) you.citedObservationIds.add(o.id);
    for (const m of o.mentions)
      if (m.entityType === 'COMPETITOR' && m.competitorId) {
        const entity = byCompetitor.get(m.competitorId);
        if (entity) record(entity, o, null);
      }
    for (const c of o.citations)
      if (c.competitorId) byCompetitor.get(c.competitorId)?.citedObservationIds.add(o.id);
  }

  // ---- AI extraction of recommended brands and reasons (verified against the answer text).
  await progress(15, 'Finding the brands each answer recommends');
  const llm = options.llm === undefined ? getLlmProvider() : options.llm;
  let extraction: ExtractionOutcome = { byObservation: new Map(), model: null, failures: [] };
  if (llm && !llm.isDevAdapter && answers.length) {
    extraction = await extractBrands(
      prisma,
      llm,
      answers
        .slice(0, MAX_EXTRACTED_ANSWERS)
        .map((o) => ({ id: o.id, prompt: o.promptText, text: o.answerText! })),
      {
        workspaceId: project.workspaceId,
        projectId,
        analysisId,
        runStartedAt: Date.now(),
        backgroundJobId: options.backgroundJobId,
      },
    );
    if (extraction.failures.length)
      notes.push(
        `AI extraction failed for part of the answers (${extraction.failures[0]}). Brands in those answers were found from cited websites only.`,
      );
    if (answers.length > MAX_EXTRACTED_ANSWERS)
      notes.push(`AI extraction covered the ${MAX_EXTRACTED_ANSWERS} most recent answers.`);
  } else if (answers.length) {
    notes.push(
      'No AI provider is configured for extraction, so brands were found only where an answer names a website it cites. Reasons per brand need extraction.',
    );
  }

  const answerById = new Map(answers.map((o) => [o.id, o]));
  for (const [observationId, brands] of extraction.byObservation) {
    const o = answerById.get(observationId)!;
    for (const extracted of brands) {
      const key = brandKey(extracted.name);
      let entity = entities.get(key) ?? trackedFor(key);
      if (!entity) {
        entity = newEntity(
          { name: extracted.name, key, isYou: false, competitorId: null, tracked: false, domain: null, detection: 'ai_extraction' },
          [extracted.name],
        ); // prettier-ignore
        entities.set(key, entity);
      } else if (!entity.terms.some((t) => t.toLowerCase() === extracted.name.toLowerCase())) {
        entity.terms.push(extracted.name);
      }
      record(entity, o, extracted.name);
      for (const reason of extracted.reasons) {
        const entry = entity.reasons.get(reason.attribute) ?? { answers: new Set<string>(), quotes: [] };
        entry.answers.add(o.id);
        if (entry.quotes.length < 2) entry.quotes.push(quoteOf(o, reason.quote));
        entity.reasons.set(reason.attribute, entry);
      }
    }
  }

  // ---- Brands named in an answer that also cites their website (found without AI).
  const citedDomains = new Map<string, number>();
  for (const o of answers)
    for (const c of o.citations) citedDomains.set(c.domain, (citedDomains.get(c.domain) ?? 0) + 1);
  const domainBrandCandidates = [...citedDomains.keys()].filter(
    (d) =>
      !isSameOrSubdomain(d, project.domain) &&
      !platformType(d) &&
      !isFileHost(d) &&
      domainLabel(d).length >= 3,
  );
  for (const domain of domainBrandCandidates) {
    const key = brandKey(domainLabel(domain));
    for (const o of answers) {
      if (entities.get(key)?.observationIds.has(o.id)) continue;
      const plain = plainAnswer(o.answerText!);
      const spelling = findSpelling(plain, key);
      if (!spelling) continue;
      // "Adobe" from adobe.com inside "Adobe Express": count the longer brand the answer names, not a second one.
      const longer = [...entities.values()].find(
        (e) => e.brand.key !== key && e.brand.key.startsWith(key) && containsTerm(plain, e.brand.name),
      );
      if (longer) {
        record(longer, o, longer.brand.tracked ? null : longer.brand.name);
        continue;
      }
      let entity = entities.get(key) ?? trackedFor(key);
      if (!entity) {
        entity = newEntity(
          { name: spelling, key, isYou: false, competitorId: null, tracked: false, domain: registrableDomain(domain), detection: 'domain' },
          [spelling],
        ); // prettier-ignore
        entities.set(key, entity);
      }
      record(entity, o, spelling);
    }
  }

  // ---- Brand domains (for untracked brands) and citations of each brand's own site.
  const entityForDomain = (domain: string): EntityState | null => {
    for (const entity of entities.values())
      if (entity.brand.domain && isSameOrSubdomain(domain, entity.brand.domain)) return entity;
    const label = brandKey(domainLabel(domain));
    if (label.length < 3) return null;
    for (const entity of entities.values()) {
      if (entity.brand.tracked) continue;
      const k = entity.brand.key;
      if (k === label || (label.length >= 4 && k.startsWith(label)) || (k.length >= 4 && label.startsWith(k)))
        return entity;
    }
    return null;
  };
  for (const domain of citedDomains.keys()) {
    if (platformType(domain) || (isFileHost(domain) && !entityForDomain(domain))) continue;
    const entity = entityForDomain(domain);
    if (entity && !entity.brand.domain) entity.brand.domain = registrableDomain(domain);
  }
  for (const o of answers)
    for (const c of o.citations) {
      if (c.isOwnedDomain) continue;
      const entity = entityForDomain(c.domain);
      if (entity && !entity.brand.isYou) entity.citedObservationIds.add(o.id);
    }

  // ---- Finalize brands.
  const total = answers.length;
  for (const entity of entities.values()) {
    const b = entity.brand;
    b.answers = entity.observationIds.size;
    b.mentionRate = total ? b.answers / total : 0;
    b.citedAnswers = entity.citedObservationIds.size;
    b.promptIds = [...entity.promptIds];
    if (!b.tracked && entity.variants.size)
      b.name = [...entity.variants.entries()].sort((a, c) => c[1] - a[1])[0]![0];
    if (b.tracked) {
      // A spelling that stored mention matching cannot catch: it does not contain the name or an alias as whole
      // words, and it is not just the domain name (domains are matched separately).
      const known = [b.name, ...aliasesOf(b.isYou ? project.brandAliases : project.competitors.find((c) => c.id === b.competitorId)?.aliases)];
      const domainKey = b.domain ? brandKey(domainLabel(b.domain)) : null;
      b.aliasSuggestion =
        [...entity.variants.entries()]
          .sort((x, y) => y[1] - x[1])
          .map(([v]) => v)
          .find((v) => !known.some((k) => containsTerm(v, k)) && brandKey(v) !== domainKey) ?? null;
    } // prettier-ignore
    b.reasons = [...entity.reasons.entries()]
      .map(([attribute, r]) => ({ attribute, answers: r.answers.size, quotes: r.quotes }))
      .sort((a, c) => c.answers - a.answers || a.attribute.localeCompare(c.attribute))
      .slice(0, 8);
    // Sentences naming the brand, preferring different prompts.
    const quotes: GapQuote[] = [];
    const usedPrompts = new Set<string>();
    const ordered = [...entity.observationIds].map((id) => answerById.get(id)!).filter(Boolean);
    for (const pass of [0, 1]) {
      for (const o of ordered) {
        if (quotes.length >= MAX_QUOTES) break;
        if (pass === 0 && usedPrompts.has(o.promptId)) continue;
        if (quotes.some((q) => q.observationId === o.id)) continue;
        const sentence = sentences(o.answerText!).find((s) => entity.terms.some((t) => containsTerm(s, t)));
        if (!sentence) continue;
        quotes.push(quoteOf(o, sentence));
        usedPrompts.add(o.promptId);
      }
    }
    b.quotes = quotes;
  }
  const brands = [...entities.values()]
    .map((e) => e.brand)
    .filter((b) => b.isYou || b.tracked || b.answers > 0)
    .sort(
      (a, c) => Number(c.isYou) - Number(a.isYou) || c.answers - a.answers || a.name.localeCompare(c.name),
    );
  const others = brands
    .filter((b) => !b.isYou)
    .sort((a, c) => c.answers - a.answers || a.name.localeCompare(c.name));
  const namedIn = new Map<string, string[]>(); // observationId → brand names (not yours)
  for (const entity of entities.values()) {
    if (entity.brand.isYou) continue;
    for (const id of entity.observationIds) namedIn.set(id, [...(namedIn.get(id) ?? []), entity.brand.name]);
  }

  // ---- Sources.
  await progress(35, 'Classifying the websites AI cites');
  const sourceMap = new Map<
    string,
    GapSource & {
      observationIds: Set<string>;
      urlCounts: Map<string, { title: string | null; citations: number }>;
    }
  >();
  for (const o of answers)
    for (const c of o.citations) {
      const entity = c.isOwnedDomain ? you : entityForDomain(c.domain);
      const domain =
        entity?.brand.domain && isSameOrSubdomain(c.domain, entity.brand.domain)
          ? entity.brand.domain
          : c.domain;
      let source = sourceMap.get(domain);
      if (!source) {
        const type: GapSourceType = c.isOwnedDomain || isSameOrSubdomain(c.domain, project.domain)
          ? 'OWN_SITE'
          : entity?.brand.tracked
            ? 'TRACKED_COMPETITOR'
            : (platformType(c.domain) ?? (entity ? 'RECOMMENDED_BRAND' : isFileHost(c.domain) ? 'FILE_HOST' : 'OTHER'));
        source = {
          domain, type, brand: type === 'OWN_SITE' ? project.name : (entity?.brand.name ?? null), answers: 0, citations: 0,
          urls: [], brandsInAnswers: [], youNamedInAnswers: 0, comparisonPages: [], checks: [],
          observationIds: new Set(), urlCounts: new Map(),
        };
        sourceMap.set(domain, source);
      } // prettier-ignore
      source.citations += 1;
      source.observationIds.add(o.id);
      const url = comparableUrl(c.url) ?? c.url;
      const entry = source.urlCounts.get(url) ?? { title: c.title, citations: 0 };
      entry.citations += 1;
      source.urlCounts.set(url, entry);
    }
  const sources: GapSource[] = [...sourceMap.values()]
    .map(({ observationIds, urlCounts, ...s }) => {
      const urls = [...urlCounts.entries()]
        .map(([url, v]) => ({ url, title: v.title, citations: v.citations }))
        .sort((a, b) => b.citations - a.citations || a.url.localeCompare(b.url));
      let type = s.type;
      if (type === 'OTHER' && urls.some((u) => ARTICLE_PATH.test(pathOf(u.url)))) type = 'COMPARISON_ARTICLE';
      const named = new Set<string>();
      let youNamed = 0;
      for (const id of observationIds) {
        for (const name of namedIn.get(id) ?? []) named.add(name);
        if (you.observationIds.has(id)) youNamed += 1;
      }
      return {
        ...s,
        type,
        answers: observationIds.size,
        urls: urls.slice(0, 8),
        brandsInAnswers: [...named].sort(),
        youNamedInAnswers: youNamed,
        comparisonPages:
          type === 'RECOMMENDED_BRAND' || type === 'TRACKED_COMPETITOR'
            ? urls
                .filter((u) => COMPARISON_PATH.test(pathOf(u.url)))
                .map((u) => u.url)
                .slice(0, 5)
            : [],
      };
    })
    .sort((a, b) => b.answers - a.answers || b.citations - a.citations || a.domain.localeCompare(b.domain));

  // ---- Attributes credited to other brands.
  const attributeMap = new Map<
    string,
    { answers: Set<string>; brands: Set<string>; example: string | null }
  >();
  for (const entity of entities.values()) {
    if (entity.brand.isYou) continue;
    for (const [attribute, r] of entity.reasons) {
      const entry = attributeMap.get(attribute) ?? {
        answers: new Set<string>(),
        brands: new Set<string>(),
        example: null,
      };
      for (const id of r.answers) entry.answers.add(id);
      entry.brands.add(entity.brand.name);
      entry.example ??= r.quotes[0]?.text ?? null;
      attributeMap.set(attribute, entry);
    }
  }
  const attributeList = [...attributeMap.entries()]
    .map(([attribute, v]) => ({ attribute, answers: v.answers.size, brands: [...v.brands].sort(), example: v.example, observationIds: v.answers }))
    .sort((a, b) => b.answers - a.answers || a.attribute.localeCompare(b.attribute))
    .slice(0, 20); // prettier-ignore

  // ---- Your crawl: pages for prompts and attribute keyword checks.
  await progress(45, 'Matching questions to your pages');
  const crawl = await prisma.crawlJob.findFirst({
    where: { projectId, status: 'SUCCEEDED' },
    orderBy: { finishedAt: 'desc' },
    select: { id: true },
  });
  const pages = crawl
    ? await prisma.crawledPage.findMany({
        where: { crawlJobId: crawl.id, isHtml: true, statusCode: 200 },
        select: { url: true, title: true, h1: true, metaDescription: true, headings: true },
        take: 20_000,
      })
    : [];
  const pageWords = pages.map((p) => {
    const headings = Array.isArray(p.headings)
      ? (p.headings as { level?: number; text?: string }[])
          .filter((h) => (h.level ?? 9) <= 3)
          .map((h) => h.text ?? '')
      : [];
    const pathText = pathOf(p.url).replace(/[-_/.]+/g, ' ');
    return {
      url: p.url,
      title: p.title,
      // What the page is about: its address, title and main heading. Listing pages mention everything in their
      // sub-headings, so headings and descriptions only count for the keyword checks.
      target: new Set(contentWords([pathText, p.title ?? '', p.h1 ?? ''].join(' '))),
      words: new Set(
        contentWords([pathText, p.title ?? '', p.h1 ?? '', p.metaDescription ?? '', ...headings].join(' ')),
      ),
    };
  });
  const bestPage = (phrase: string) => {
    const words = contentWords(phrase);
    if (!words.length || !pageWords.length) return null;
    let best: {
      url: string;
      title: string | null;
      matched: string[];
      missing: string[];
      score: number;
    } | null = null;
    for (const p of pageWords) {
      const matched = words.filter((w) => p.target.has(w));
      const score = matched.length / words.length;
      if (!best || score > best.score || (score === best.score && p.url.length < best.url.length))
        best = { url: p.url, title: p.title, matched, missing: words.filter((w) => !p.target.has(w)), score };
    }
    return best && best.score >= 0.6 && best.matched.length >= Math.min(2, words.length) ? best : null;
  };

  // ---- Prompts.
  const promptMap = new Map<string, (typeof answers)[number][]>();
  for (const o of answers) promptMap.set(o.promptId, [...(promptMap.get(o.promptId) ?? []), o]);
  const prompts: GapPrompt[] = [...promptMap.entries()]
    .map(([promptId, list]) => {
      const names = new Map<string, number>();
      const domains = new Map<string, number>();
      const attributes = new Map<string, Set<string>>();
      let answersNamingBrands = 0;
      for (const o of list) {
        const named = namedIn.get(o.id) ?? [];
        if (named.length || you.observationIds.has(o.id)) answersNamingBrands += 1;
        for (const name of named) names.set(name, (names.get(name) ?? 0) + 1);
        // One count per answer and source (a brand's file host is part of the brand's source).
        const resolved = new Set(
          o.citations.map((c) => sources.find((s) => s.domain === c.domain || isSameOrSubdomain(c.domain, s.domain))?.domain ?? c.domain),
        );
        for (const d of resolved) domains.set(d, (domains.get(d) ?? 0) + 1);
      }
      for (const a of attributeList)
        for (const o of list) if (a.observationIds.has(o.id)) attributes.set(a.attribute, (attributes.get(a.attribute) ?? new Set()).add(o.id));
      const topSources = [...domains.entries()]
        .map(([domain, n]) => ({ domain, type: sources.find((s) => s.domain === domain)?.type ?? ('OTHER' as GapSourceType), answers: n }))
        .sort((a, b) => b.answers - a.answers || a.domain.localeCompare(b.domain))
        .slice(0, 6);
      return {
        promptId,
        prompt: list[0]!.promptText,
        answers: list.length,
        youNamed: list.filter((o) => you.observationIds.has(o.id)).length,
        youCited: list.filter((o) => you.citedObservationIds.has(o.id)).length,
        brandsNamed: [...names.entries()].map(([name, n]) => ({ name, answers: n })).sort((a, b) => b.answers - a.answers || a.name.localeCompare(b.name)),
        topSources,
        attributes: [...attributes.entries()].map(([attribute, ids]) => ({ attribute, answers: ids.size })).sort((a, b) => b.answers - a.answers).slice(0, 6),
        answersNamingBrands,
        recommendsBrands: answersNamingBrands > 0,
        yourPage: bestPage(list[0]!.promptText),
        pageMatchAvailable: pageWords.length > 0,
      };
    })
    .sort((a, b) => b.answers - b.youNamed - (a.answers - a.youNamed) || a.prompt.localeCompare(b.prompt)); // prettier-ignore

  // ---- Readiness: latest audit.
  const auditRun = await prisma.auditRun.findFirst({
    where: { projectId, status: 'SUCCEEDED' },
    orderBy: { finishedAt: 'desc' },
    select: { id: true, score: true, finishedAt: true, pagesAnalyzed: true },
  });
  const issueCounts = auditRun
    ? await prisma.auditIssue.groupBy({
        by: ['ruleId'],
        where: { projectId, status: 'OPEN', ruleId: { in: READINESS_RULES } },
        _count: { _all: true },
      })
    : [];
  const readiness: GapReadiness = {
    robots: { url: new URL('/robots.txt', project.websiteUrl).toString(), status: 'not_checked', httpStatus: null, error: null, agents: AI_CRAWLERS.map((c) => ({ ...c, allowed: null })) },
    homepage: { url: project.websiteUrl, status: 'NOT_CHECKED', httpStatus: null, title: null, metaDescription: null, h1: null, wordCount: null, schemaTypes: [], error: null },
    audit: auditRun
      ? {
          auditRunId: auditRun.id,
          score: auditRun.score,
          finishedAt: auditRun.finishedAt?.toISOString() ?? null,
          pagesAnalyzed: auditRun.pagesAnalyzed,
          issues: issueCounts
            .map((i) => ({ ruleId: i.ruleId, title: getAuditRule(i.ruleId)?.title ?? i.ruleId, count: i._count._all }))
            .sort((a, b) => READINESS_RULES.indexOf(a.ruleId) - READINESS_RULES.indexOf(b.ruleId)),
        }
      : null,
  }; // prettier-ignore

  // ---- Live checks: robots.txt for AI crawlers, the homepage, and pages AI cites.
  const attributeTerms = new Map(attributeList.map((a) => [a.attribute, contentWords(a.attribute)]));
  const homepageNeedles = [...new Set([...attributeTerms.values()].flat())].slice(0, 300);
  let homepageMatches: Record<string, boolean> = {};
  const liveChecks = options.liveChecks !== false;
  if (liveChecks) {
    await progress(55, 'Checking robots.txt and your homepage');
    const fetcher = options.fetcher ?? new SafeFetcher({ ...options.fetcherOptions, timeoutMs: 15_000 });
    const robotsCache = new Map();
    try {
      try {
        readiness.robots = await checkRobots(fetcher, project.websiteUrl);
      } catch (error) {
        readiness.robots.error = errorMessage(error).slice(0, 300);
      }
      const home = await checkPage(project.websiteUrl, {
        fetcher,
        robotsCache,
        textNeedles: homepageNeedles,
      });
      homepageMatches = home.textMatches;
      readiness.homepage = {
        url: project.websiteUrl,
        status: home.status,
        httpStatus: home.httpStatus,
        title: home.title,
        metaDescription: home.metaDescription,
        h1: home.h1,
        wordCount: home.status === 'OK' ? home.wordCount : null,
        schemaTypes: [
          ...new Set(
            home.jsonLd.flatMap((node) => {
              const t = node['@type'];
              return Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
            }),
          ),
        ].sort(),
        error: home.error,
      };

      await progress(70, 'Checking pages AI cites for your brand');
      const youNeedles = [...new Set(you.terms)];
      const brandNeedles = others.slice(0, 20).map((b) => b.name);
      // Pages that can list brands, articles first; one page per site before a second one; no documents.
      const order: GapSourceType[] = [
        'COMPARISON_ARTICLE',
        'REVIEW_DIRECTORY',
        'OTHER',
        'COMMUNITY',
        'PRESS_RELEASE',
      ];
      const candidates = sources
        .filter((s) => order.includes(s.type))
        .flatMap((s) =>
          s.urls
            .filter((u) => !NON_HTML_PATH.test(pathOf(u.url)))
            .slice(0, 2)
            .map((u, rank) => ({ source: s, url: u.url, rank })),
        );
      const checkable = candidates
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            order.indexOf(a.source.type) - order.indexOf(b.source.type) ||
            b.source.answers - a.source.answers ||
            a.url.localeCompare(b.url),
        )
        .slice(0, MAX_PAGE_CHECKS);
      await inPool(checkable, 3, async ({ source, url }) => {
        const result = await checkPage(url, {
          fetcher,
          robotsCache,
          textNeedles: [...youNeedles, ...brandNeedles],
          linkTargets: [project.domain],
        });
        const check: GapPageCheck = {
          url,
          status: result.status,
          title: result.title,
          brandsOnPage: result.status === 'OK' ? others.filter((b) => result.textMatches[b.name]).map((b) => b.name) : [],
          youOnPage: result.status === 'OK' ? youNeedles.some((n) => result.textMatches[n]) || result.links.length > 0 : null,
          linksToYou: result.status === 'OK' ? result.links.length > 0 : null,
          checkedAt: result.checkedAt,
          note: result.status === 'OK' ? null : result.error,
        }; // prettier-ignore
        source.checks.push(check);
      });
    } finally {
      if (!options.fetcher) await fetcher.close();
    }
  } else {
    notes.push('Live checks were skipped: robots.txt, your homepage and cited pages were not fetched.');
  }

  const attributes: GapAttribute[] = attributeList.map((a) => {
    const base = { attribute: a.attribute, answers: a.answers, brands: a.brands, example: a.example };
    const words = attributeTerms.get(a.attribute) ?? [];
    if (!words.length) return { ...base, onYourSite: null, matchedOn: null };
    const homepageChecked = readiness.homepage.status === 'OK';
    if (homepageChecked && words.every((w) => homepageMatches[w]))
      return { ...base, onYourSite: true, matchedOn: project.websiteUrl };
    const page = pageWords.find((p) => words.every((w) => p.words.has(w)));
    if (page) return { ...base, onYourSite: true, matchedOn: page.url };
    return { ...base, onYourSite: homepageChecked || pageWords.length ? false : null, matchedOn: null };
  });

  const providers = [...new Set(answers.map((o) => o.provider))].sort();
  if (providers.length > 1)
    notes.push(
      `Answers come from ${providers.length} providers (${providers.join(', ')}), which answer differently.`,
    );

  const result: GapAnalysisResult = {
    version: 1,
    window: { from: from.toISOString(), to: now.toISOString(), days: WINDOW_DAYS },
    answers: total,
    demoAnswersExcluded,
    prompts,
    providers,
    you: you.brand,
    brands,
    attributes,
    sources,
    readiness,
    actions: [],
    method: {
      brandDetection: extraction.byObservation.size ? 'ai_extraction' : 'domain_only',
      extractionModel: extraction.model,
      answersExtracted: extraction.byObservation.size,
      liveChecks,
    },
    notes,
  };
  result.actions = buildGapActions(result, { name: project.name, domain: project.domain });
  return result;
}

// ---------------- Actions ----------------

function list(items: string[], max = 4): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  const text = shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : text;
}

function pct(n: number, total: number): string {
  return total ? `${Math.round((100 * n) / total)}%` : '0%';
}

/** Builds the prioritized plan from a finished analysis. Pure: the same evidence always gives the same actions. */
export function buildGapActions(
  r: Omit<GapAnalysisResult, 'actions'>,
  project: { name: string; domain: string },
): GapAction[] {
  const actions: GapAction[] = [];
  const evidence = (e: Partial<GapAction['evidence']> = {}): GapAction['evidence'] => ({
    promptIds: e.promptIds ?? [],
    urls: e.urls ?? [],
    observationIds: e.observationIds ?? [],
    brands: e.brands ?? [],
  });
  const others = r.brands.filter((b) => !b.isYou && b.answers > 0);
  const leader = others[0];

  // 1. Crawlers that power AI search cannot read the site.
  const robots = r.readiness.robots;
  if (robots.status === 'unreachable')
    actions.push({
      key: 'robots-unreachable',
      priority: 1,
      category: 'TECHNICAL_SEO',
      title: 'Make robots.txt reachable',
      why: `${robots.url} could not be fetched (${robots.error ?? `HTTP ${robots.httpStatus}`}). Crawlers then treat the whole site as off-limits, so AI search cannot read any page.`,
      steps: [
        'Make sure /robots.txt answers with HTTP 200 (or 404 if you want no rules).',
        'Run this analysis again to confirm.',
      ],
      evidence: evidence({ urls: [robots.url] }),
      link: null,
    });
  else {
    const blocked = robots.agents.filter((a) => a.search && a.allowed === false);
    if (blocked.length)
      actions.push({
        key: 'crawler-access',
        priority: 1,
        category: 'TECHNICAL_SEO',
        title: `Allow ${list(blocked.map((a) => a.agent))} in robots.txt`,
        why: `${robots.url} blocks ${list(blocked.map((a) => a.label))} from your homepage. These crawlers decide which websites AI search can show, so your pages cannot be cited there.`,
        steps: [
          `Remove the Disallow rules that apply to ${list(blocked.map((a) => a.agent))} for your public pages.`,
          'Keep private areas (for example customers’ own invitations or accounts) disallowed.',
          'Run this analysis again to confirm the change.',
        ],
        evidence: evidence({ urls: [robots.url] }),
        link: null,
      });
  }

  // 2. The homepage itself.
  const home = r.readiness.homepage;
  if (home.status !== 'NOT_CHECKED' && home.status !== 'OK')
    actions.push({
      key: 'homepage-unreachable',
      priority: 1,
      category: 'TECHNICAL_SEO',
      title: 'Make your homepage readable for crawlers',
      why: `Your homepage (${home.url}) could not be read: ${home.error ?? home.status}.`,
      steps: [
        'Open the homepage from outside your network and fix the error.',
        'If robots.txt blocks it, allow public pages.',
        'Run this analysis again to confirm.',
      ],
      evidence: evidence({ urls: [home.url] }),
      link: null,
    });
  else if (home.status === 'OK' && (home.wordCount ?? 0) < 150)
    actions.push({
      key: 'homepage-thin',
      priority: 2,
      category: 'TECHNICAL_SEO',
      title: 'Put your homepage content in the HTML, not only in JavaScript',
      why: `Without running JavaScript, your homepage shows only ${home.wordCount ?? 0} words. Crawlers that do not run JavaScript, several AI crawlers among them, see an almost empty page and cannot tell what ${project.name} offers.`,
      steps: [
        'Render the main content on the server or prerender it, so it is in the HTML response.',
        `State plainly, in text, what ${project.name} is, who it is for and its main features.`,
        'Run an audit and this analysis again to confirm.',
      ],
      evidence: evidence({ urls: [home.url] }),
      link: { label: 'Website audit', path: 'audits' },
    });

  // 3. No audit, or entity basics missing.
  if (!r.readiness.audit)
    actions.push({
      key: 'run-audit',
      priority: 2,
      category: 'TECHNICAL_SEO',
      title: 'Run a website audit',
      why: 'There is no completed audit, so this analysis cannot check which of your pages answer each question or find technical problems.',
      steps: ['Open Website Audit and run an audit.', 'Run this analysis again when it finishes.'],
      evidence: evidence(),
      link: { label: 'Website audit', path: 'audits' },
    });
  else {
    const entityRules = r.readiness.audit.issues.filter((i) =>
      ['organization-schema-missing', 'structured-data-none'].includes(i.ruleId),
    );
    if (entityRules.length)
      actions.push({
        key: 'entity-schema',
        priority: 3,
        category: 'GEO',
        title: 'Describe your brand with Organization structured data',
        why: `The latest audit found: ${list(entityRules.map((i) => i.title.toLowerCase()))}. Structured data helps machines connect ${project.domain} with the ${project.name} brand, its logo and official profiles. It does not guarantee citations.`,
        steps: [
          'Add Organization (or LocalBusiness) JSON-LD to the homepage: name, url, logo and sameAs links to your official profiles.',
          'Use only facts that are true and visible on your site.',
        ],
        evidence: evidence(),
        link: { label: 'Open issues', path: 'issues' },
      });
  }

  // 4. Questions where other brands are named and yours is not.
  const gapPrompts = r.prompts.filter(
    (p) => p.recommendsBrands && p.youNamed === 0 && p.brandsNamed.length > 0,
  );
  for (const p of gapPrompts.slice(0, 6)) {
    const named = p.brandsNamed.map((b) => `${b.name} (${b.answers})`);
    const credited = p.attributes.map((a) => a.attribute);
    const sources = p.topSources
      .filter((s) => s.type !== 'OWN_SITE' && s.type !== 'FILE_HOST')
      .map((s) => s.domain);
    const base = `In ${p.answers} answer${p.answers === 1 ? '' : 's'} to “${p.prompt}”, AI named ${list(named)}; ${project.name} was not named.`;
    const extra = [
      credited.length ? `Reasons given for them: ${list(credited, 5)}.` : '',
      sources.length ? `Sources cited: ${list(sources, 4)}.` : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (p.pageMatchAvailable && !p.yourPage)
      actions.push({
        key: `prompt-page:${p.promptId}`,
        priority: 2,
        category: 'AEO',
        title: `Create a page that answers “${p.prompt.slice(0, 120)}”`,
        why: `${base} No page in your latest crawl targets this question (its words are not in any page address, title or heading). ${extra}`.trim(),
        steps: [
          'Write a page whose title and first paragraph answer this question directly.',
          credited.length
            ? `Cover what the answers compare (${list(credited, 5)}), describing honestly what ${project.name} offers for each.`
            : 'Cover the criteria people use to choose, describing honestly what you offer for each.',
          'Add examples, real prices and other facts people can verify. Do not claim features you do not have.',
          'Link the page from your homepage or main navigation, then run an audit and new AI checks.',
        ],
        evidence: evidence({ promptIds: [p.promptId], brands: p.brandsNamed.map((b) => b.name) }),
        link: { label: 'Content Studio', path: 'content' },
      });
    else if (p.yourPage)
      actions.push({
        key: `prompt-page:${p.promptId}`,
        priority: 3,
        category: 'AEO',
        title: `Strengthen ${p.yourPage.url} for “${p.prompt.slice(0, 100)}”`,
        why: `${base} Your closest page is ${p.yourPage.url}${p.yourPage.missing.length ? `; it does not mention ${list(p.yourPage.missing)} in its address, title or headings` : ''}. ${extra}`.trim(),
        steps: [
          'Answer the question in the page’s first paragraph and make the title match it.',
          credited.length
            ? `Add sections on ${list(credited, 5)}, if ${project.name} offers them.`
            : 'Add sections on the criteria people compare.',
          'Add a short FAQ with the questions customers actually ask.',
        ],
        evidence: evidence({
          promptIds: [p.promptId],
          urls: [p.yourPage.url],
          brands: p.brandsNamed.map((b) => b.name),
        }),
        link: { label: 'Content Studio', path: 'content' },
      });
    else if (!p.pageMatchAvailable)
      actions.push({
        key: `prompt-page:${p.promptId}`,
        priority: 2,
        category: 'AEO',
        title: `Answer “${p.prompt.slice(0, 120)}” on your site`,
        why: `${base} ${extra}`.trim(),
        steps: [
          'Run a website audit so pages can be matched to this question.',
          'If no page answers it, write one that answers it directly in the first paragraph.',
        ],
        evidence: evidence({ promptIds: [p.promptId], brands: p.brandsNamed.map((b) => b.name) }),
        link: { label: 'Content Studio', path: 'content' },
      });
  }

  // 5. What answers praise competitors for, missing from your pages.
  const missing = r.attributes.filter((a) => a.answers >= 2 && a.onYourSite === false).slice(0, 6);
  if (missing.length)
    actions.push({
      key: 'state-strengths',
      priority: 2,
      category: 'CONTENT',
      title: `Say clearly what ${project.name} offers`,
      why: `Answers recommend other brands for ${list(
        missing.map(
          (a) => `${a.attribute} (${a.answers} answers${a.example ? `, e.g. “${a.example}”` : ''})`,
        ),
        6,
      )}. These words were not found on your homepage or in your page titles and headings.`,
      steps: [
        `For each feature ${project.name} really has, say so on the homepage and on a feature page, in plain words.`,
        'For features you do not have, decide whether customers need them. Never claim a feature you do not offer.',
        'Run this analysis again after publishing.',
      ],
      evidence: evidence({ brands: [...new Set(missing.flatMap((a) => a.brands))] }),
      link: { label: 'Content Studio', path: 'content' },
    });

  // 6. Third-party pages AI cites that list other brands but not yours.
  const checked = r.sources.flatMap((s) => s.checks.map((c) => ({ source: s, check: c })));
  // Lists and reviews: articles or directories naming a brand, or any page naming two or more (a product site that
  // mentions one rival is not a list to ask to join).
  const listsWithoutYou = checked.filter(
    (x) =>
      x.check.status === 'OK' &&
      !x.check.youOnPage &&
      (x.check.brandsOnPage.length >= 2 ||
        (x.check.brandsOnPage.length >= 1 &&
          (x.source.type === 'COMPARISON_ARTICLE' || x.source.type === 'REVIEW_DIRECTORY'))),
  );
  if (listsWithoutYou.length)
    actions.push({
      key: 'third-party-lists',
      priority: 2,
      category: 'AUTHORITY',
      title: 'Get included on the pages AI cites',
      why: `AI answers cite ${listsWithoutYou.length} page${listsWithoutYou.length === 1 ? '' : 's'} that name ${list([...new Set(listsWithoutYou.flatMap((x) => x.check.brandsOnPage))])} but not ${project.name} (checked live): ${list(listsWithoutYou.map((x) => x.check.url), 3)}.`,
      steps: [
        'Read each page and check whether your service genuinely fits its topic.',
        'Contact the author or editor with accurate, useful information: what you offer, prices and screenshots.',
        'Do not pay for undisclosed placements or ask for misleading claims.',
        'After a page is updated, run this analysis again to confirm.',
      ],
      evidence: evidence({ urls: listsWithoutYou.map((x) => x.check.url), brands: [...new Set(listsWithoutYou.flatMap((x) => x.check.brandsOnPage))] }),
      link: null,
    }); // prettier-ignore

  // 7. Competitors' own comparison pages are cited.
  const comparison = r.sources.filter((s) => s.comparisonPages.length && s.type !== 'OWN_SITE');
  if (comparison.length)
    actions.push({
      key: 'comparison-guide',
      priority: 3,
      category: 'AEO',
      title: 'Publish an honest comparison guide on your site',
      why: `AI cites comparison pages that brands publish about their own market: ${list(
        comparison.map(
          (s) => `${s.comparisonPages[0]} (${s.brand ?? s.domain}, cited in ${s.answers} answers)`,
        ),
        3,
      )}.`,
      steps: [
        'Write a guide that compares the main options fairly, including competitors, with clear criteria.',
        `Explain where ${project.name} fits and where another option may suit someone better.`,
        'Date the guide and update it when products change.',
      ],
      evidence: evidence({ urls: comparison.flatMap((s) => s.comparisonPages).slice(0, 10) }),
      link: { label: 'Content Studio', path: 'content' },
    });

  // 8. Platform sources.
  const ofType = (type: GapSourceType) => r.sources.filter((s) => s.type === type);
  const community = ofType('COMMUNITY');
  if (community.length)
    actions.push({
      key: 'community',
      priority: 3,
      category: 'AUTHORITY',
      title: 'Take part in the discussions AI reads',
      why: `AI answers cite community discussions (${list(community.map((s) => `${s.domain}: ${s.answers} answers`))}). Threads: ${list(
        community.flatMap((s) => s.urls.map((u) => u.url)),
        3,
      )}.`,
      steps: [
        'Read the cited threads to learn what people ask and which complaints come up.',
        `Reply only where you can genuinely help, as yourself, and say that you work for ${project.name}.`,
        'Follow each community’s rules. Never use fake accounts, paid upvotes or mass posting.',
      ],
      evidence: evidence({ urls: community.flatMap((s) => s.urls.map((u) => u.url)).slice(0, 10) }),
      link: null,
    });
  const stores = ofType('APP_STORE');
  // Store figures the answers actually quoted ("with a 4.8 rating", "1M+ downloads").
  const storeFigures = [
    ...new Set(
      r.brands.flatMap((b) =>
        b.reasons.flatMap((reason) => reason.quotes.map((q) => q.text).filter((t) => STORE_FIGURE.test(t))),
      ),
    ),
  ].slice(0, 3);
  if (stores.length)
    actions.push({
      key: 'app-store',
      priority: 3,
      category: 'AUTHORITY',
      title: 'Treat app store listings as evidence AI reads',
      why: `AI answers cite app store listings in ${stores.reduce((n, s) => n + s.answers, 0)} answers, e.g. ${list(
        stores.flatMap((s) => s.urls.map((u) => u.url)),
        2,
      )}.${storeFigures.length ? ` Answers quote figures such as ${list(storeFigures.map((t) => `“${t}”`))}.` : ''}`,
      steps: [
        `If ${project.name} has an app, keep the listing complete: clear description, screenshots, languages and features.`,
        'Ask real customers for reviews after a good experience. Never buy, fake or incentivize reviews.',
        'If you have no app, publish the same facts on your website.',
      ],
      evidence: evidence({ urls: stores.flatMap((s) => s.urls.map((u) => u.url)).slice(0, 10) }),
      link: null,
    });
  const press = ofType('PRESS_RELEASE');
  if (press.length)
    actions.push({
      key: 'press',
      priority: 4,
      category: 'AUTHORITY',
      title: 'Announce genuine news',
      why: `AI answers cite press releases (${list(press.map((s) => s.domain))}).`,
      steps: [
        'When you have real news (a launch, a milestone, a partnership), publish it on your site and through a press release service.',
        'Label it as a press release; keep claims factual.',
      ],
      evidence: evidence({ urls: press.flatMap((s) => s.urls.map((u) => u.url)).slice(0, 10) }),
      link: null,
    });
  const video = ofType('VIDEO');
  if (video.length)
    actions.push({
      key: 'video',
      priority: 4,
      category: 'CONTENT',
      title: 'Publish how-to videos',
      why: `AI answers cite videos (${list(
        video.flatMap((s) => s.urls.map((u) => u.url)),
        2,
      )}).`,
      steps: [
        `Record short tutorials that show how to do the task with ${project.name}.`,
        'Describe them accurately in the title and description, and link to your site.',
      ],
      evidence: evidence({ urls: video.flatMap((s) => s.urls.map((u) => u.url)).slice(0, 10) }),
      link: null,
    });

  // 9. Brands AI recommends that are not tracked.
  const untracked = others.filter((b) => !b.tracked && b.answers >= Math.min(2, r.answers));
  if (untracked.length)
    actions.push({
      key: 'track-brands',
      priority: 3,
      category: 'GEO',
      title: `Track ${list(untracked.map((b) => b.name), 3)} as competitors`,
      why: `${list(untracked.map((b) => `${b.name} (named in ${b.answers} of ${r.answers} answers)`), 5)} ${untracked.length === 1 ? 'is' : 'are'} not tracked, so share of voice leaves ${untracked.length === 1 ? 'it' : 'them'} out.${leader && !leader.tracked ? ` ${leader.name} is the most-named brand (${pct(leader.answers, r.answers)} of answers).` : ''}`,
      steps: ['Add them as competitors (up to your plan’s limit), then link them to your prompts.', 'Run AI checks again so the charts include them.'],
      evidence: evidence({ brands: untracked.map((b) => b.name) }),
      link: { label: 'Project settings', path: 'settings' },
      trackBrands: untracked.slice(0, 10).map((b) => ({ name: b.name, domain: b.domain })),
    }); // prettier-ignore

  // 10. Tracking hygiene.
  const aliasFixes = r.brands.filter((b) => b.tracked && b.aliasSuggestion);
  if (aliasFixes.length)
    actions.push({
      key: 'aliases',
      priority: 4,
      category: 'GEO',
      title: 'Add the spellings answers use',
      why: `Answers write ${list(aliasFixes.map((b) => `“${b.aliasSuggestion}” for ${b.name}`))}. Without these aliases, the visibility charts can miss mentions.`,
      steps: [
        'Add the spellings as aliases (brand aliases in project settings, competitor aliases on the competitor).',
      ],
      evidence: evidence({ brands: aliasFixes.map((b) => b.name) }),
      link: { label: 'Project settings', path: 'settings' },
    });
  // Prompts where at most half of the answers name any brand: mostly the AI does the task instead of recommending.
  const taskPrompts = r.prompts.filter((p) => p.answers >= 1 && p.answersNamingBrands * 2 <= p.answers);
  if (taskPrompts.length)
    actions.push({
      key: 'rephrase-prompts',
      priority: 4,
      category: 'AEO',
      title: 'Track questions that ask for a recommendation',
      why: `${list(
        taskPrompts.map((p) => `${p.answersNamingBrands} of ${p.answers} answers to “${p.prompt}”`),
        3,
      )} named any brand; the others named none. Such prompts mostly get the task done by the AI itself rather than a service recommended, so they say little about which brands AI recommends.`,
      steps: [
        'Track questions people ask when choosing a service, for example “Which website is best for …?” or “What is the best app to …?”.',
        'Keep these prompts only if you also want to see how AI handles the task itself.',
      ],
      evidence: evidence({ promptIds: taskPrompts.map((p) => p.promptId) }),
      link: { label: 'AI Visibility', path: 'visibility' },
    });

  return actions.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

// ---------------- Job ----------------

export async function executeGapAnalysis(
  prisma: PrismaClient,
  analysisId: string,
  options: GapAnalysisOptions = {},
): Promise<{ answers: number; actions: number }> {
  const analysis = await prisma.visibilityGapAnalysis.findUniqueOrThrow({ where: { id: analysisId } });
  await prisma.visibilityGapAnalysis.update({
    where: { id: analysisId },
    data: { status: 'RUNNING', startedAt: analysis.startedAt ?? new Date(), errorMessage: null },
  });
  const result = await buildGapAnalysis(prisma, analysis.projectId, analysisId, options);
  await prisma.visibilityGapAnalysis.update({
    where: { id: analysisId },
    data: {
      status: 'SUCCEEDED',
      result: result as unknown as Prisma.InputJsonValue,
      finishedAt: new Date(),
    },
  });
  return { answers: result.answers, actions: result.actions.length };
}

/** Saves one action of an analysis as a recommendation (idempotent per action key; dismissed ones stay dismissed). */
export function saveGapActionAsRecommendation(
  prisma: PrismaClient,
  projectId: string,
  analysisId: string,
  action: GapAction,
): Promise<{ id: string; created: boolean }> {
  return upsertEvidenceRecommendation(prisma, projectId, {
    fingerprintKey: `gap|${action.key}`,
    source: 'AI_VISIBILITY',
    title: action.title,
    category: action.category,
    priority: action.priority,
    relatedUrl: action.evidence.urls[0] ?? null,
    evidence: { gapAnalysisId: analysisId, actionKey: action.key, why: action.why, ...action.evidence },
    steps: action.steps,
  });
}

/** Classification of a cited domain by platform alone (no project context); null for ordinary websites. */
export function classifyPlatform(domain: string): GapSourceType | null {
  return platformType(domain) ?? (isFileHost(domain) ? 'FILE_HOST' : null);
}
