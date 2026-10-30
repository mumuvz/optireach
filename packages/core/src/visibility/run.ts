// Executes an AI visibility run: every selected prompt × provider produces one stored observation
// (success or failure), with brand/competitor mentions and normalized citations.
import {
  SENTIMENTS,
  VISIBILITY_PROVIDERS,
  VISIBILITY_PROVIDER_KEYS,
  captureMethodOfProvider,
  type PromptFrequency,
  type Sentiment,
  type VisibilityProviderKey,
} from '@surfaced/shared';
import { z } from 'zod';
import { ProviderError, getLlmProvider, type LlmProvider } from '../ai/llm';
import type { Prisma, PrismaClient } from '../db';
import { errorMessage } from '../errors';
import type { JobTracker } from '../jobs';
import { getLogger } from '../logger';
import { recordProviderUsage } from '../costs';
import { recordUsage } from '../usage';

/** Vendor key used for provider cost tracking. */
const PROVIDER_VENDOR: Partial<Record<VisibilityProviderKey, string>> = {
  openai_web_search: 'openai',
  openai_model_knowledge: 'openai',
  perplexity_sonar: 'perplexity',
  gemini_model_knowledge: 'gemini',
  dataforseo_ai_mode: 'dataforseo',
};

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
import {
  extractUrls,
  findMentions,
  normalizeCitations,
  type EntitySpec,
  type MatchedMention,
} from './matching';
import { getVisibilityProvider, type VisibilityContext, type VisibilityResult } from './providers';

const MAX_PROVIDER_ATTEMPTS = 3;
const RUN_CONCURRENCY = 3;

export function nextPromptRun(frequency: PromptFrequency, from = new Date()): Date | null {
  const next = new Date(from);
  if (frequency === 'DAILY') next.setUTCDate(next.getUTCDate() + 1);
  else if (frequency === 'WEEKLY') next.setUTCDate(next.getUTCDate() + 7);
  else if (frequency === 'MONTHLY') next.setUTCMonth(next.getUTCMonth() + 1);
  else return null;
  return next;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function observeWithRetry(
  key: VisibilityProviderKey,
  request: Parameters<ReturnType<typeof getVisibilityProvider>['observe']>[0],
  context: VisibilityContext,
): Promise<{ result: VisibilityResult; attempts: number }> {
  const provider = getVisibilityProvider(key);
  if (!provider.status().configured) throw new ProviderError('NOT_CONFIGURED', provider.status().detail);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return { result: await provider.observe(request, context), attempts: attempt };
    } catch (error) {
      const providerError =
        error instanceof ProviderError
          ? error
          : new ProviderError('UPSTREAM_ERROR', errorMessage(error), true);
      if (!providerError.retryable || attempt >= MAX_PROVIDER_ATTEMPTS) {
        (providerError as ProviderError & { attempts?: number }).attempts = attempt;
        throw providerError;
      }
      const backoff =
        providerError.retryAfterMs ?? Math.min(30_000, 1000 * 2 ** attempt + Math.floor(Math.random() * 500));
      await sleep(backoff);
    }
  }
}

const analysisSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      refersToEntity: z.boolean(),
      sentiment: z.enum(SENTIMENTS),
    }),
  ),
  confidence: z.number(),
});

/** Optional AI step: confirm that matches refer to the entities (not generic words) and estimate sentiment. */
async function verifyWithLlm(
  llm: LlmProvider,
  answer: string,
  mentions: MatchedMention[],
): Promise<{
  confirmed: Set<string>;
  brandSentiment: Sentiment | null;
  confidence: number | null;
  model: string;
} | null> {
  if (llm.isDevAdapter || mentions.length === 0) return null;
  const candidates = mentions
    .map((m) => `- ${m.entity.name} (website: ${m.entity.domain || 'unknown'})`)
    .join('\n');
  try {
    const { data, model } = await llm.generateJson({
      schema: analysisSchema,
      schemaName: 'entity_mention_analysis',
      system:
        'You analyze an AI assistant answer. For each candidate entity, decide whether the answer actually refers to that specific company, product or brand (not a generic word with the same spelling), and classify the sentiment the answer expresses toward it. Use NEUTRAL when it is only listed. Be conservative.',
      user: `Candidate entities:\n${candidates}\n\nAnswer:\n"""\n${answer.slice(0, 12_000)}\n"""`,
      maxOutputTokens: 800,
    });
    const confirmed = new Set(data.entities.filter((e) => e.refersToEntity).map((e) => e.name.toLowerCase()));
    const brand = mentions.find((m) => m.entity.type === 'BRAND');
    const brandEntry = brand
      ? data.entities.find((e) => e.name.toLowerCase() === brand.entity.name.toLowerCase())
      : undefined;
    return {
      confirmed,
      brandSentiment: brandEntry?.refersToEntity ? brandEntry.sentiment : null,
      confidence: Math.max(0, Math.min(1, data.confidence)),
      model,
    };
  } catch (error) {
    getLogger('visibility').warn(
      { err: errorMessage(error) },
      'Mention verification failed; keeping deterministic matches',
    );
    return null;
  }
}

export interface VisibilityRunOutcome {
  observations: number;
  succeeded: number;
  failed: number;
}

export async function executeVisibilityRun(
  prisma: PrismaClient,
  runId: string,
  promptIds: string[] | null,
  tracker: JobTracker | null,
  llm: LlmProvider | null = getLlmProvider(),
): Promise<VisibilityRunOutcome> {
  const run = await prisma.aiVisibilityRun.findUniqueOrThrow({
    where: { id: runId },
    include: { project: { include: { competitors: { where: { status: 'CONFIRMED' } } } } },
  });
  const project = run.project;
  const prompts = await prisma.aiPrompt.findMany({
    where: {
      projectId: project.id,
      ...(promptIds?.length ? { id: { in: promptIds } } : { status: 'ACTIVE' }),
    },
    include: { competitors: { select: { competitorId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  await prisma.aiVisibilityRun.update({
    where: { id: runId },
    data: { status: 'RUNNING', startedAt: run.startedAt ?? new Date(), promptCount: prompts.length },
  });

  // Coordinates of a business location per city, for providers that take a position (AI Mode).
  const locations = await prisma.businessLocation.findMany({
    where: { projectId: project.id, archivedAt: null, latitude: { not: null }, longitude: { not: null } },
    select: { city: true, latitude: true, longitude: true, isPrimary: true },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  });
  const coordinatesFor = (city: string | null) => {
    if (!city) return null;
    const match = locations.find((l) => l.city.trim().toLowerCase() === city.trim().toLowerCase());
    return match ? { latitude: Number(match.latitude), longitude: Number(match.longitude) } : null;
  };
  const aliases = (value: Prisma.JsonValue) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const tasks = prompts.flatMap((prompt) =>
    (Array.isArray(prompt.providers) ? (prompt.providers as string[]) : [])
      .filter((p): p is VisibilityProviderKey => (VISIBILITY_PROVIDER_KEYS as readonly string[]).includes(p))
      .map((provider) => ({ prompt, provider })),
  );
  let done = 0;
  let succeeded = 0;
  let failed = 0;

  const processTask = async ({ prompt, provider }: (typeof tasks)[number]) => {
    const idempotencyKey = `${runId}:${prompt.id}:${provider}`;
    const existing = await prisma.aiVisibilityObservation.findUnique({
      where: { idempotencyKey },
      select: { status: true },
    });
    if (existing) {
      if (existing.status === 'SUCCEEDED') succeeded += 1;
      else failed += 1;
      return;
    }
    const selectedIds = new Set(prompt.competitors.map((c) => c.competitorId));
    const competitorRows = project.competitors.filter((c) => selectedIds.size === 0 || selectedIds.has(c.id));
    const brand: EntitySpec = {
      id: null,
      type: 'BRAND',
      name: prompt.targetBrand,
      domain: project.domain,
      aliases: aliases(project.brandAliases),
    };
    const competitors: EntitySpec[] = competitorRows.map((c) => ({
      id: c.id,
      type: 'COMPETITOR',
      name: c.name,
      domain: c.domain,
      aliases: aliases(c.aliases),
    }));
    const context: VisibilityContext = { brand, competitors };

    try {
      const { result, attempts } = await observeWithRetry(
        provider,
        { prompt: prompt.text, country: prompt.country, city: prompt.city, coordinates: coordinatesFor(prompt.city), language: prompt.language }, // prettier-ignore
        context,
      );
      let mentions = findMentions(result.answerText, [brand, ...competitors]);
      const rawCitations = result.citations.length ? result.citations : extractUrls(result.answerText);
      const citations = normalizeCitations(rawCitations, project.domain, competitors);

      let sentiment: Sentiment | null = null;
      let sentimentSource: string | null = null;
      let sentimentConfidence: number | null = null;
      if (result.isDemo) {
        sentiment = result.fixtureSentiment ?? null;
        sentimentSource = sentiment ? 'DEMO_FIXTURE' : null;
      } else if (llm) {
        const verified = await verifyWithLlm(llm, result.answerText, mentions);
        if (verified) {
          mentions = mentions
            .filter((m) => m.matchType === 'DOMAIN' || verified.confirmed.has(m.entity.name.toLowerCase()))
            .map((m, index) => ({ ...m, rank: index + 1 }));
          sentiment = verified.brandSentiment;
          sentimentSource = sentiment ? 'AI_ESTIMATE' : null;
          sentimentConfidence = sentiment ? verified.confidence : null;
        }
      }
      const brandMention = mentions.find((m) => m.entity.type === 'BRAND');
      await prisma.$transaction(async (tx) => {
        const observation = await tx.aiVisibilityObservation.create({
          data: {
            runId,
            promptId: prompt.id,
            projectId: project.id,
            provider,
            model: result.model,
            country: prompt.country,
            city: prompt.city,
            language: prompt.language,
            promptText: prompt.text,
            status: 'SUCCEEDED',
            isDemo: result.isDemo,
            captureMethod: result.captureMethod ?? (result.isDemo ? 'DEMO' : 'API'),
            limitations: (result.limitations ?? (result.isDemo ? ['Demo fixture: not a real AI answer.'] : [])) as Prisma.InputJsonValue, // prettier-ignore
            attempts,
            rawResponse: result.raw as Prisma.InputJsonValue,
            answerText: result.answerText,
            brandMentioned: Boolean(brandMention),
            brandCited: citations.some((c) => c.isOwnedDomain),
            brandRank: brandMention?.rank ?? null,
            sentiment,
            sentimentSource,
            sentimentConfidence,
            latencyMs: result.latencyMs,
            usage: (result.usage ?? undefined) as Prisma.InputJsonValue | undefined,
            idempotencyKey,
          },
        });
        if (mentions.length) {
          await tx.brandMention.createMany({
            data: mentions.map((m) => ({
              observationId: observation.id,
              entityType: m.entity.type,
              competitorId: m.entity.id,
              entityName: m.entity.name.slice(0, 120),
              matchedText: m.matchedText.slice(0, 255),
              matchType: m.matchType,
              position: m.position,
              rank: m.rank,
              snippet: m.snippet,
              confidence: null,
            })),
          });
        }
        if (citations.length) {
          await tx.aiCitation.createMany({
            data: citations.slice(0, 100).map((c) => ({
              observationId: observation.id,
              url: c.url,
              domain: c.domain,
              title: c.title,
              position: c.position,
              sourceType: c.sourceType,
              isOwnedDomain: c.isOwnedDomain,
              competitorId: c.competitorId,
            })),
          });
        }
        await recordUsage(tx, {
          workspaceId: project.workspaceId,
          projectId: project.id,
          metric: 'VISIBILITY_CHECK',
          quantity: 1,
          idempotencyKey: `visibility:${idempotencyKey}`,
        });
      });
      if (!result.isDemo)
        await recordProviderUsage(prisma, {
          workspaceId: project.workspaceId,
          projectId: project.id,
          provider: PROVIDER_VENDOR[provider] ?? provider,
          // Web search calls are billed separately from tokens, so they get their own operation.
          operation:
            VISIBILITY_PROVIDERS[provider].kind === 'live_search'
              ? 'visibility_web_search'
              : 'visibility_check',
          model: result.model,
          inputTokens: numberOrNull(result.usage?.inputTokens ?? result.usage?.input_tokens),
          outputTokens: numberOrNull(result.usage?.outputTokens ?? result.usage?.output_tokens),
          idempotencyKey: `visibility:${idempotencyKey}`,
        });
      succeeded += 1;
    } catch (error) {
      const providerError = error instanceof ProviderError ? error : null;
      await prisma.aiVisibilityObservation.create({
        data: {
          runId,
          promptId: prompt.id,
          projectId: project.id,
          provider,
          country: prompt.country,
          city: prompt.city,
          language: prompt.language,
          promptText: prompt.text,
          status: 'FAILED',
          isDemo: provider === 'mock_demo',
          captureMethod: captureMethodOfProvider(provider),
          attempts: (error as { attempts?: number }).attempts ?? 1,
          errorCode: providerError?.code ?? 'INTERNAL_ERROR',
          errorMessage: errorMessage(error).slice(0, 1000),
          idempotencyKey,
        },
      });
      failed += 1;
    } finally {
      done += 1;
      await tracker?.progress(
        (done / Math.max(1, tasks.length)) * 100,
        `Checked ${done} of ${tasks.length} prompt/provider pairs`,
      );
    }
  };

  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(RUN_CONCURRENCY, Math.max(1, queue.length)) }, async () => {
    while (queue.length) {
      if (tracker && (await tracker.isCancelRequested())) return;
      const task = queue.shift();
      if (task) await processTask(task);
    }
  });
  await Promise.all(workers);

  const now = new Date();
  for (const prompt of prompts) {
    await prisma.aiPrompt.update({
      where: { id: prompt.id },
      data: { lastRunAt: now, nextRunAt: nextPromptRun(prompt.frequency, now) },
    });
  }
  const cancelled = queue.length > 0;
  await prisma.aiVisibilityRun.update({
    where: { id: runId },
    data: {
      status: cancelled ? 'CANCELLED' : tasks.length > 0 && succeeded === 0 ? 'FAILED' : 'SUCCEEDED',
      observationCount: succeeded + failed,
      successCount: succeeded,
      failureCount: failed,
      errorMessage:
        tasks.length > 0 && succeeded === 0 && !cancelled
          ? 'Every provider call failed. Check provider configuration and the observation errors.'
          : null,
      finishedAt: now,
    },
  });
  return { observations: succeeded + failed, succeeded, failed };
}
