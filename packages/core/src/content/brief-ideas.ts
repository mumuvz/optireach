// Generates a content-brief proposal for one topic: the real questions people ask an AI assistant or search
// engine, plus the editor fields needed to answer them. Grounded in what the business actually shows (its
// description, pages, products and keywords). Produces no measured metrics — it is an editorial proposal only,
// and is clearly labelled as AI-generated (or as a development template). Runs on the chosen LLM provider so the
// same topic can be proposed by each provider and the results compared.
import type { SearchIntent } from '@surfaced/shared';
import { getLlmProvider, ProviderError, type LlmProvider, type LlmProviderKey } from '../ai/llm';
import type { PrismaClient } from '../db';
import { businessContext } from '../keywords';
import { recordUsage } from '../usage';
import {
  BRIEF_IDEAS_SYSTEM_PROMPT,
  briefIdeasOutputSchema,
  buildBriefIdeasPrompt,
  devBriefIdeas,
} from './generation';

export interface BriefIdeasPayload {
  projectId: string;
  /** The topic to build the brief around. */
  seed: string;
  country: string;
  language: string;
  questionCount: number;
  /** Which LLM provider to run on; absent uses the server default. */
  provider?: LlmProviderKey | null;
}

export interface BriefIdeasProposal {
  title: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  searchIntent: SearchIntent;
  targetAudience: string;
  angle: string;
  wordCountTarget: number;
  questions: { question: string; intent: SearchIntent; rationale: string }[];
  outlineHeadings: string[];
}

export interface BriefIdeasResult {
  proposal: BriefIdeasProposal;
  isDevAdapter: boolean;
  /** The provider that produced the proposal, so comparisons can be labelled by provider. */
  provider: LlmProviderKey;
  model: string;
  label: string;
}

const clampInt = (value: number, min: number, max: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

const cleanList = (values: string[], maxItems: number, maxLen: number) => {
  const seen = new Set<string>();
  return values
    .map((v) => v.trim().slice(0, maxLen))
    .filter((v) => v.length > 0 && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase()))
    .slice(0, maxItems);
};

/** Generates one content-brief proposal. No metrics are produced; the result is labelled by provider. */
export async function executeBriefIdeas(
  prisma: PrismaClient,
  backgroundJobId: string,
  payload: BriefIdeasPayload,
  llm: LlmProvider | null = getLlmProvider(),
): Promise<BriefIdeasResult> {
  if (!llm)
    throw new ProviderError(
      'NOT_CONFIGURED',
      'Brief generation needs an LLM provider (LLM_PROVIDER=none).',
    );
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: payload.projectId },
    include: { competitors: { select: { name: true } } },
  });
  const seed = payload.seed.trim();
  const context = await businessContext(prisma, project);
  const identity = `Business: ${project.name}${project.websiteUrl ? ` (${project.websiteUrl})` : ''}${project.industry ? `, industry ${project.industry}` : ''}.`;
  const count = clampInt(payload.questionCount, 3, 12, 6);

  const { data, model, isDevAdapter } = await llm.generateJson({
    schema: briefIdeasOutputSchema,
    schemaName: 'content_brief_ideas',
    system: BRIEF_IDEAS_SYSTEM_PROMPT,
    user: buildBriefIdeasPrompt(
      seed || project.name,
      [identity, context].filter(Boolean).join('\n'),
      payload.country,
      payload.language,
      count,
    ),
    maxOutputTokens: Math.min(6000, 1500 + count * 220),
    devFallback: () => devBriefIdeas(seed, project.name, count),
  });

  const questionSeen = new Set<string>();
  const questions = data.questions
    .map((q) => ({
      question: q.question.trim().slice(0, 300),
      intent: q.intent,
      rationale: q.rationale.trim().slice(0, 300),
    }))
    .filter(
      (q) =>
        q.question.length > 1 &&
        !questionSeen.has(q.question.toLowerCase()) &&
        questionSeen.add(q.question.toLowerCase()),
    )
    .slice(0, count);

  const proposal: BriefIdeasProposal = {
    title: data.title.trim().slice(0, 255) || `${seed || project.name}: a complete guide`,
    primaryKeyword: (data.primaryKeyword.trim() || seed || project.name).slice(0, 200),
    secondaryKeywords: cleanList(data.secondaryKeywords, 20, 200),
    searchIntent: data.searchIntent,
    targetAudience: data.targetAudience.trim().slice(0, 500),
    angle: data.angle.trim().slice(0, 500),
    wordCountTarget: clampInt(data.wordCountTarget, 300, 4000, 1200),
    questions,
    outlineHeadings: cleanList(data.outlineHeadings, 12, 200),
  };

  await recordUsage(prisma, {
    workspaceId: project.workspaceId,
    projectId: project.id,
    metric: 'CONTENT_GENERATION',
    quantity: 1,
    idempotencyKey: `brief-ideas:${backgroundJobId}`,
  });

  return {
    proposal,
    isDevAdapter,
    provider: llm.key,
    model,
    label: isDevAdapter
      ? 'Development adapter template — not AI-generated. Configure an LLM provider for a real proposal.'
      : `AI-generated brief proposal from ${llm.label} (${model}) — an editorial suggestion, not measured search data.`,
  };
}
