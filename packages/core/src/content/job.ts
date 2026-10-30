// Executes one content generation request (outline, article, meta, FAQ, schema or a single section).
import { replaceMarkdownSection } from '@surfaced/shared/markdown';
import type { ContentGenerationMode, FaqItem } from '@surfaced/shared';
import { getLlmProvider, ProviderError, type LlmProvider } from '../ai/llm';
import type { Prisma, PrismaClient } from '../db';
import { recordProviderUsage } from '../costs';
import { recordUsage } from '../usage';
import {
  CONTENT_SYSTEM_PROMPT,
  articleOutputSchema,
  buildUserPrompt,
  devArticle,
  devFaqs,
  devMeta,
  devOutline,
  devSection,
  faqOutputSchema,
  metaOutputSchema,
  outlineOutputSchema,
  outlineToMarkdown,
  sectionOutputSchema,
  type ContentContext,
} from './generation';
import { buildArticleJsonLd, suggestInternalLinks } from './linking';
import { createContentVersion, latestVersion } from './versions';

export interface ContentJobPayload {
  documentId: string;
  mode: ContentGenerationMode;
  sectionHeading?: string;
  instructions?: string;
  userId?: string;
}

export interface ContentJobResult {
  versionId: string;
  versionNumber: number;
  isDevAdapter: boolean;
  model: string | null;
}

const asStrings = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];

export async function executeContentGeneration(
  prisma: PrismaClient,
  backgroundJobId: string,
  payload: ContentJobPayload,
  llm: LlmProvider | null = getLlmProvider(),
): Promise<ContentJobResult> {
  const already = await prisma.contentVersion.findUnique({ where: { generationJobId: backgroundJobId } });
  if (already)
    return {
      versionId: already.id,
      versionNumber: already.versionNumber,
      isDevAdapter: already.isDevAdapter,
      model: already.model,
    };

  const document = await prisma.contentDocument.findUniqueOrThrow({
    where: { id: payload.documentId },
    include: { brief: true, project: true },
  });
  const current = await latestVersion(prisma, document.id);
  const brief = document.brief;
  const project = document.project;
  const languages = asStrings(project.targetLanguages);
  const countries = asStrings(project.targetCountries);

  const keyword = brief?.primaryKeyword ?? document.title;
  const links =
    payload.mode === 'article' || payload.mode === 'section'
      ? (
          await suggestInternalLinks(prisma, project.id, {
            keyword,
            title: document.title,
            secondary: asStrings(brief?.secondaryKeywords),
            excludeUrl: document.targetUrl,
          })
        ).suggestions
      : [];
  const ctx: ContentContext = {
    brandName: project.name,
    brandUrl: project.websiteUrl,
    industry: project.industry,
    brandVoice: brief?.brandVoice ?? project.brandVoice,
    title: current?.title ?? document.title,
    primaryKeyword: keyword,
    secondaryKeywords: asStrings(brief?.secondaryKeywords),
    searchIntent: brief?.searchIntent ?? 'INFORMATIONAL',
    targetAudience: brief?.targetAudience ?? null,
    country: brief?.country ?? countries[0] ?? 'US',
    language: brief?.language ?? languages[0] ?? 'en',
    wordCountTarget: brief?.wordCountTarget ?? 1200,
    notes: brief?.notes ?? null,
    outline:
      (current?.outline as ContentContext['outline']) ??
      (brief?.outline as ContentContext['outline']) ??
      null,
    existingMarkdown: current?.body ?? null,
    instructions: payload.instructions ?? null,
    internalLinks: links.map((l) => ({ url: l.url, anchorText: l.anchorText })),
  };

  const base = {
    title: current?.title ?? document.title,
    body: current?.body ?? '',
    outline: (current?.outline ?? null) as Prisma.InputJsonValue | null,
    metaTitle: current?.metaTitle ?? null,
    metaDescription: current?.metaDescription ?? null,
    faqs: (current?.faqs ?? null) as Prisma.InputJsonValue | null,
    internalLinks: (current?.internalLinks ?? null) as Prisma.InputJsonValue | null,
    schemaJsonLd: (current?.schemaJsonLd ?? null) as Prisma.InputJsonValue | null,
  };

  if (payload.mode === 'schema') {
    const faqs = (Array.isArray(current?.faqs) ? current.faqs : []) as unknown as FaqItem[];
    const schema = buildArticleJsonLd({
      title: base.title,
      description: base.metaDescription,
      url: document.targetUrl,
      language: ctx.language,
      brandName: project.name,
      brandUrl: project.websiteUrl,
      faqs,
      dateModified: new Date(),
    });
    const version = await createContentVersion(prisma, document.id, {
      ...base,
      schemaJsonLd: schema as Prisma.InputJsonValue,
      source: 'AI_GENERATION',
      provider: 'deterministic',
      model: null,
      generationJobId: backgroundJobId,
      note: 'Schema JSON-LD built from the document content (no AI call).',
      createdById: payload.userId ?? null,
    });
    return { versionId: version.id, versionNumber: version.versionNumber, isDevAdapter: false, model: null };
  }

  if (!llm)
    throw new ProviderError(
      'NOT_CONFIGURED',
      'Content generation is not configured on this server (LLM_PROVIDER=none).',
    );
  const user = buildUserPrompt(payload.mode, ctx, payload.sectionHeading);
  let next: typeof base = { ...base };
  let meta: {
    provider: string;
    model: string;
    isDevAdapter: boolean;
    usage?: { inputTokens: number | null; outputTokens: number | null } | null;
  };
  let source: 'AI_GENERATION' | 'AI_SECTION' = 'AI_GENERATION';
  let note = `Generated ${payload.mode}`;

  switch (payload.mode) {
    case 'outline': {
      const result = await llm.generateJson({
        schema: outlineOutputSchema,
        schemaName: 'article_outline',
        system: CONTENT_SYSTEM_PROMPT,
        user,
        maxOutputTokens: 2500,
        devFallback: () => devOutline(ctx),
      });
      meta = result;
      next = {
        ...next,
        title: result.data.title || next.title,
        outline: result.data.sections as unknown as Prisma.InputJsonValue,
        body: next.body.trim() ? next.body : outlineToMarkdown(result.data.sections),
      };
      if (brief)
        await prisma.contentBrief.update({
          where: { id: brief.id },
          data: { outline: result.data.sections as unknown as Prisma.InputJsonValue },
        });
      break;
    }
    case 'article': {
      const result = await llm.generateJson({
        schema: articleOutputSchema,
        schemaName: 'article_draft',
        system: CONTENT_SYSTEM_PROMPT,
        user,
        devFallback: () => devArticle(ctx),
      });
      meta = result;
      next = {
        ...next,
        title: result.data.title || next.title,
        body: result.data.markdown,
        metaTitle: result.data.metaTitle.slice(0, 255),
        metaDescription: result.data.metaDescription.slice(0, 500),
        faqs: result.data.faqs as unknown as Prisma.InputJsonValue,
        internalLinks: links as unknown as Prisma.InputJsonValue,
      };
      break;
    }
    case 'meta': {
      const result = await llm.generateJson({
        schema: metaOutputSchema,
        schemaName: 'meta_tags',
        system: CONTENT_SYSTEM_PROMPT,
        user,
        maxOutputTokens: 600,
        devFallback: () => devMeta(ctx),
      });
      meta = result;
      next = {
        ...next,
        metaTitle: result.data.metaTitle.slice(0, 255),
        metaDescription: result.data.metaDescription.slice(0, 500),
      };
      break;
    }
    case 'faq': {
      const result = await llm.generateJson({
        schema: faqOutputSchema,
        schemaName: 'faq_suggestions',
        system: CONTENT_SYSTEM_PROMPT,
        user,
        maxOutputTokens: 1500,
        devFallback: () => devFaqs(ctx),
      });
      meta = result;
      next = { ...next, faqs: result.data.faqs as unknown as Prisma.InputJsonValue };
      break;
    }
    case 'section': {
      if (!payload.sectionHeading)
        throw new ProviderError('INVALID_REQUEST', 'A section heading is required.');
      const result = await llm.generateJson({
        schema: sectionOutputSchema,
        schemaName: 'section_rewrite',
        system: CONTENT_SYSTEM_PROMPT,
        user,
        maxOutputTokens: 2500,
        devFallback: () => devSection(ctx, payload.sectionHeading!),
      });
      const replaced = replaceMarkdownSection(next.body, payload.sectionHeading, result.data.markdown);
      if (replaced === null)
        throw new ProviderError(
          'INVALID_REQUEST',
          `Section "${payload.sectionHeading}" was not found in the document.`,
        );
      meta = result;
      source = 'AI_SECTION';
      note = `Regenerated section "${payload.sectionHeading}"`;
      next = { ...next, body: replaced };
      break;
    }
    default:
      throw new ProviderError('INVALID_REQUEST', `Unsupported mode ${String(payload.mode)}`);
  }

  const version = await createContentVersion(prisma, document.id, {
    ...next,
    source,
    provider: meta.provider,
    model: meta.model,
    isDevAdapter: meta.isDevAdapter,
    generationJobId: backgroundJobId,
    note,
    createdById: payload.userId ?? null,
  });
  await recordUsage(prisma, {
    workspaceId: project.workspaceId,
    projectId: project.id,
    metric: 'CONTENT_GENERATION',
    quantity: 1,
    idempotencyKey: `content:${backgroundJobId}`,
  });
  if (!meta.isDevAdapter)
    await recordProviderUsage(prisma, {
      workspaceId: project.workspaceId,
      projectId: project.id,
      provider: meta.provider,
      operation: 'content_generation',
      model: meta.model,
      inputTokens: meta.usage?.inputTokens ?? null,
      outputTokens: meta.usage?.outputTokens ?? null,
      backgroundJobId,
      idempotencyKey: `content:${backgroundJobId}`,
    });
  return {
    versionId: version.id,
    versionNumber: version.versionNumber,
    isDevAdapter: meta.isDevAdapter,
    model: meta.model,
  };
}
