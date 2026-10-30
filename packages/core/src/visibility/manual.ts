// Manual AI observations: what a person saw in an AI system that has no API for tracking (Google AI Mode and AI
// Overviews, the ChatGPT or Gemini apps…). The pasted answer is analyzed like an API answer (brand and competitor
// mentions, links), and the observation is labeled manual with who entered it, when and where it was seen.
import {
  AI_SURFACE_LABELS,
  manualObservationSchema,
  manualProviderKey,
  type ManualObservationInput,
} from '@surfaced/shared';
import type { Prisma, PrismaClient } from '../db';
import { Errors } from '../errors';
import { extractUrls, findMentions, normalizeCitations, type EntitySpec } from './matching';
import type { ProviderCitation } from './providers';

export async function recordManualObservation(
  prisma: PrismaClient,
  params: { projectId: string; userId: string; input: ManualObservationInput; now?: Date },
): Promise<{ observationId: string; runId: string }> {
  const input = manualObservationSchema.parse(params.input);
  const now = params.now ?? new Date();
  const observedAt = input.observedAt ? new Date(input.observedAt) : now;
  if (observedAt.getTime() > now.getTime() + 5 * 60_000) throw Errors.badRequest('The observation date is in the future.'); // prettier-ignore
  const prompt = await prisma.aiPrompt.findFirst({
    where: { id: input.promptId, projectId: params.projectId },
    include: { competitors: { select: { competitorId: true } }, project: { include: { competitors: { where: { status: 'CONFIRMED' } } } } }, // prettier-ignore
  });
  if (!prompt) throw Errors.notFound('Prompt');
  const project = prompt.project;
  const aliases = (value: Prisma.JsonValue) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const selected = new Set(prompt.competitors.map((c) => c.competitorId));
  const competitors: EntitySpec[] = project.competitors
    .filter((c) => selected.size === 0 || selected.has(c.id))
    .map((c) => ({
      id: c.id,
      type: 'COMPETITOR',
      name: c.name,
      domain: c.domain,
      aliases: aliases(c.aliases),
    }));
  const brand: EntitySpec = { id: null, type: 'BRAND', name: prompt.targetBrand, domain: project.domain, aliases: aliases(project.brandAliases) }; // prettier-ignore
  const mentions = findMentions(input.answerText, [brand, ...competitors]);
  const linked: ProviderCitation[] = input.citedUrls.map((url) => ({
    url,
    title: null,
    sourceType: 'INLINE_CITATION',
  }));
  const citations = normalizeCitations(
    [...linked, ...extractUrls(input.answerText)],
    project.domain,
    competitors,
  );
  const brandMention = mentions.find((m) => m.entity.type === 'BRAND');
  const surfaceLabel = AI_SURFACE_LABELS[input.surface];
  const country = input.country ?? prompt.country;
  const city = input.city === undefined ? prompt.city : input.city;

  return prisma.$transaction(async (tx) => {
    const run = await tx.aiVisibilityRun.create({
      data: {
        projectId: project.id,
        trigger: 'MANUAL',
        status: 'SUCCEEDED',
        promptCount: 1,
        observationCount: 1,
        successCount: 1,
        startedAt: now,
        finishedAt: now,
      },
    });
    const observation = await tx.aiVisibilityObservation.create({
      data: {
        runId: run.id,
        promptId: prompt.id,
        projectId: project.id,
        provider: manualProviderKey(input.surface),
        model: null,
        country,
        city,
        language: prompt.language,
        promptText: prompt.text,
        status: 'SUCCEEDED',
        isDemo: false,
        captureMethod: 'MANUAL',
        answerText: input.answerText,
        brandMentioned: Boolean(brandMention),
        brandCited: citations.some((c) => c.isOwnedDomain),
        brandRank: brandMention?.rank ?? null,
        rawResponse: {
          manual: true,
          surface: input.surface,
          linkedUrls: input.citedUrls.length,
        } as Prisma.InputJsonValue,
        limitations: [
          `Entered by a person from ${surfaceLabel}: one answer, seen once. AI answers vary with account, location, device and time.`,
          'Mentions are found by matching the business and competitor names, aliases and domains; they are not checked by AI.',
          ...(input.citedUrls.length
            ? []
            : ['No source links were entered, so citations come only from links written in the answer.']),
        ] as Prisma.InputJsonValue,
        capturedById: params.userId,
        note: input.note ?? null,
        idempotencyKey: `manual:${run.id}`,
        observedAt,
      },
    });
    if (mentions.length)
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
    if (citations.length)
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
    return { observationId: observation.id, runId: run.id };
  });
}
