// Answer-engine optimization (AEO) "answerability" analysis. An LLM assesses how well the site answers the
// questions people ask AI assistants and search engines, using ONLY the REAL structure of crawled pages (titles,
// headings, question-style headings, FAQ/QA schema, word counts) plus the project's target questions and business
// context. It never sees full page text and never invents metrics — the single 0–100 answerability index is a
// qualitative judgement, not a measured ranking. Runs on the chosen LLM provider so results can be compared.
import { z } from 'zod';
import { getLlmProvider, ProviderError, type LlmProvider, type LlmProviderKey } from '../ai/llm';
import type { PrismaClient } from '../db';
import { businessContext } from '../keywords';
import { recordUsage } from '../usage';

const MAX_PAGES = 30;
const MAX_QUESTIONS = 25;
const MAX_HEADINGS_PER_PAGE = 12;

export const answerabilityOutputSchema = z.object({
  score: z.number(),
  summary: z.string(),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
  findings: z.array(
    z.object({
      area: z.string(),
      status: z.enum(['good', 'fair', 'poor']),
      detail: z.string(),
      recommendation: z.string(),
    }),
  ),
  questionCoverage: z.array(
    z.object({ question: z.string(), covered: z.boolean(), note: z.string() }),
  ),
});
export type AnswerabilityAssessment = z.infer<typeof answerabilityOutputSchema>;

export interface AnswerabilityRunPayload {
  runId: string;
  projectId: string;
  /** Which LLM provider to run on; absent uses the server default. The worker resolves it to a provider. */
  provider?: LlmProviderKey | null;
}

export function answerabilityGrade(score: number): 'good' | 'fair' | 'poor' {
  return score >= 80 ? 'good' : score >= 50 ? 'fair' : 'poor';
}

const ANSWERABILITY_SYSTEM_PROMPT = [
  'You are an answer-engine optimization (AEO) analyst. Assess how well a website answers the questions people ask',
  'AI assistants and search engines, using ONLY the page structure you are given (page titles, headings, whether',
  'question-style headings and FAQ/QA schema are present, and word counts) plus the business context and the list',
  'of target questions. You cannot see full page text.',
  'Rules you must follow:',
  '- Judge only from the structural signals provided. Do not assume content you were not shown.',
  '- NEVER invent metrics: no rankings, traffic, impressions, search volume or citation counts. The only number you',
  '  produce is a single answerability index from 0 to 100 — your qualitative judgement of how well the site is',
  '  STRUCTURED to answer questions directly, not a measured value.',
  '- Higher scores mean clear question-style headings, concise direct answers implied by the structure, FAQ/QA',
  '  schema where useful, and pages that topically cover the target questions.',
  '- findings must cover: direct-answer structure, question-style headings, FAQ/QA structured data, and topical',
  '  coverage of the target questions. Each finding needs a concrete, page-level recommendation.',
  '- questionCoverage: for each target question, say whether some page appears to address it (by title/heading',
  '  match) with a short note; be honest when the structure is not enough to tell.',
  '- Write in plain English.',
].join('\n');

interface PageSummary {
  url: string;
  title: string;
  headings: string[];
  questionHeadings: number;
  hasFaqContent: boolean;
  schemaTypes: string[];
  wordCount: number;
}

function buildUserPrompt(
  identity: string,
  context: string,
  pages: PageSummary[],
  questions: string[],
): string {
  const pagesBlock = pages
    .map(
      (p, i) =>
        `${i + 1}. ${p.title || '(untitled)'} — ${p.url}\n` +
        `   headings: ${p.headings.length ? p.headings.join(' | ') : '(none captured)'}\n` +
        `   question-style headings: ${p.questionHeadings}; FAQ/QA content: ${p.hasFaqContent ? 'yes' : 'no'}; schema: ${p.schemaTypes.length ? p.schemaTypes.join(', ') : 'none'}; words: ${p.wordCount}`,
    )
    .join('\n');
  return [
    identity,
    context,
    `Target questions to be answerable for (${questions.length}):`,
    questions.map((q) => `- ${q}`).join('\n'),
    `Pages on the site (${pages.length}, structure only):`,
    pagesBlock,
    'Assess the site’s answerability for these questions from the structure above. Return the answerability index,',
    'a short summary, strengths, gaps, the findings, and per-question coverage.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Deterministic, clearly-labelled assessment from the real signals, used only by the development adapter. */
function devAssessment(pages: PageSummary[], questions: string[]): AnswerabilityAssessment {
  const withQ = pages.filter((p) => p.questionHeadings > 0).length;
  const withFaq = pages.filter(
    (p) => p.hasFaqContent || p.schemaTypes.some((t) => t === 'FAQPage' || t === 'QAPage'),
  ).length;
  const pageCount = Math.max(1, pages.length);
  const score = Math.round(((withQ / pageCount) * 0.5 + (withFaq / pageCount) * 0.5) * 100);
  const covers = (q: string) => {
    const tokens = q
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 3);
    return pages.some((p) => {
      const hay = `${p.title} ${p.headings.join(' ')}`.toLowerCase();
      return tokens.length > 0 && tokens.filter((t) => hay.includes(t)).length >= Math.ceil(tokens.length / 2);
    });
  };
  return {
    score,
    summary:
      'Development template assessment computed from page structure (not AI-generated). Configure an LLM provider for a real review.',
    strengths: [
      withQ ? `${withQ} of ${pages.length} pages use question-style headings.` : '',
      withFaq ? `${withFaq} pages have FAQ/QA content or schema.` : '',
    ].filter(Boolean),
    gaps: [
      withQ < pages.length ? `${pages.length - withQ} pages have no question-style headings.` : '',
      withFaq === 0 ? 'No pages expose FAQ or QA structured data.' : '',
    ].filter(Boolean),
    findings: [
      {
        area: 'Question-style headings',
        status: withQ > pages.length / 2 ? 'good' : withQ > 0 ? 'fair' : 'poor',
        detail: `${withQ} of ${pages.length} crawled pages phrase at least one heading as a question.`,
        recommendation: 'Add H2/H3s that state a customer question and answer it directly in the first sentence.',
      },
      {
        area: 'FAQ / QA structured data',
        status: withFaq > 0 ? 'fair' : 'poor',
        detail: `${withFaq} pages expose FAQPage/QAPage schema or FAQ-style content.`,
        recommendation: 'Mark up genuine Q&A sections with FAQPage schema so answer engines can extract them.',
      },
    ],
    questionCoverage: questions.map((q) => ({
      question: q,
      covered: covers(q),
      note: covers(q)
        ? 'A page title or heading appears to match this question.'
        : 'No page title or heading clearly matches this question.',
    })),
  };
}

/**
 * Runs one answerability analysis and persists it onto the AnswerabilityRun row. Sets the row RUNNING at the start
 * and SUCCEEDED at the end; throws on failure so the worker marks the row FAILED. The LLM provider is injected
 * (resolved from the chosen provider by the caller); passing null means "not configured".
 */
export async function executeAnswerabilityRun(
  prisma: PrismaClient,
  runId: string,
  options: { backgroundJobId?: string; llm?: LlmProvider | null } = {},
): Promise<void> {
  const run = await prisma.answerabilityRun.findUniqueOrThrow({ where: { id: runId } });
  const llm = options.llm === undefined ? getLlmProvider() : options.llm;
  if (!llm)
    throw new ProviderError(
      'NOT_CONFIGURED',
      'The answerability audit needs an LLM provider (LLM_PROVIDER=none).',
    );
  await prisma.answerabilityRun.update({ where: { id: runId }, data: { status: 'RUNNING' } });

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: run.projectId },
    include: { competitors: { select: { name: true } } },
  });
  const crawl = await prisma.crawlJob.findFirst({
    where: { projectId: run.projectId, status: 'SUCCEEDED' },
    orderBy: { finishedAt: 'desc' },
  });
  const pageRows = crawl
    ? await prisma.crawledPage.findMany({
        where: { crawlJobId: crawl.id, isHtml: true, statusCode: 200, isIndexable: true },
        select: { url: true, title: true, headings: true, signals: true, structuredData: true, wordCount: true },
        orderBy: { depth: 'asc' },
        take: MAX_PAGES,
      })
    : [];
  const pages: PageSummary[] = pageRows.map((p) => {
    const signals = (p.signals ?? {}) as { questionHeadings?: number; hasFaqContent?: boolean };
    const sd = (p.structuredData ?? {}) as { types?: string[] };
    const headings = Array.isArray(p.headings)
      ? (p.headings as { text?: string }[])
          .map((h) => (typeof h?.text === 'string' ? h.text.trim() : ''))
          .filter(Boolean)
          .slice(0, MAX_HEADINGS_PER_PAGE)
      : [];
    return {
      url: p.url,
      title: p.title ?? '',
      headings,
      questionHeadings: signals.questionHeadings ?? 0,
      hasFaqContent: Boolean(signals.hasFaqContent),
      schemaTypes: Array.isArray(sd.types) ? sd.types.filter((t): t is string => typeof t === 'string') : [],
      wordCount: p.wordCount ?? 0,
    };
  });

  const promptRows = await prisma.aiPrompt.findMany({
    where: { projectId: run.projectId },
    select: { text: true },
    take: MAX_QUESTIONS,
  });
  let questions = promptRows.map((p) => p.text.trim()).filter(Boolean);
  if (questions.length === 0) {
    const keywords = await prisma.projectKeyword.findMany({
      where: { projectId: run.projectId, isPrimary: true },
      select: { phrase: true },
      take: 12,
    });
    questions = keywords.map((k) => k.phrase);
  }

  const limitations: string[] = [
    'Assessed from page structure (titles, headings, schema), not full page text — treat it as guidance, not a measured score.',
  ];
  if (!crawl) limitations.push('No completed crawl yet — run a site audit so pages can be assessed.');
  else if (pages.length === 0) limitations.push('The last crawl found no indexable HTML pages to assess.');
  if (promptRows.length === 0)
    limitations.push('No AI prompts/questions are set up; the project’s primary keywords were used as topics.');

  const identity = `Business: ${project.name}${project.websiteUrl ? ` (${project.websiteUrl})` : ''}${project.industry ? `, industry ${project.industry}` : ''}.`;
  const context = await businessContext(prisma, project);

  const { data, model, isDevAdapter } = await llm.generateJson({
    schema: answerabilityOutputSchema,
    schemaName: 'answerability_assessment',
    system: ANSWERABILITY_SYSTEM_PROMPT,
    user: buildUserPrompt(identity, context, pages, questions),
    maxOutputTokens: 6000,
    devFallback: () => devAssessment(pages, questions),
  });

  const score = Math.min(100, Math.max(0, Math.round(data.score)));
  const assessment: AnswerabilityAssessment = {
    ...data,
    score,
    questionCoverage: data.questionCoverage.slice(0, MAX_QUESTIONS),
    findings: data.findings.slice(0, 12),
  };

  await prisma.answerabilityRun.update({
    where: { id: runId },
    data: {
      status: 'SUCCEEDED',
      provider: llm.key,
      model,
      isDevAdapter,
      score,
      grade: answerabilityGrade(score),
      assessment: assessment as unknown as object,
      pagesConsidered: pages.length,
      questionsConsidered: questions.length,
      limitations,
      finishedAt: new Date(),
    },
  });

  await recordUsage(prisma, {
    workspaceId: project.workspaceId,
    projectId: project.id,
    metric: 'CONTENT_GENERATION',
    quantity: 1,
    idempotencyKey: `answerability:${options.backgroundJobId ?? runId}`,
  });
}
