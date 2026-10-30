// Assembles report data strictly from stored project records for the selected date range.
// Missing data is reported as a limitation — never filled in.
import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_LABELS,
  RECOMMENDATION_OPEN_STATUSES,
  REPORT_SECTION_LABELS,
  getAuditRule,
  type AuditCategory,
  type IssueSeverity,
  type ReportSection,
  type VisibilityProviderKey,
} from '@surfaced/shared';
import { competitorComparison, topicGaps, type EntityComparison } from '../competitors';
import type { PrismaClient } from '../db';
import { getVisibilitySummary, type VisibilitySummary } from '../visibility/metrics';

export interface ReportData {
  title: string;
  generatedAt: string;
  period: { from: string; to: string };
  project: { name: string; websiteUrl: string | null; domain: string | null; isDemo: boolean };
  branding: { name: string; accentColor: string; whiteLabel: boolean };
  sections: ReportSection[];
  sectionLabels: Record<string, string>;
  audit: {
    runId: string;
    finishedAt: string | null;
    score: number | null;
    previousScore: number | null;
    categoryScores: { category: AuditCategory; label: string; score: number }[];
    issueCounts: { total: number; bySeverity: Record<IssueSeverity, number> };
    pagesCrawled: number;
    startUrl: string;
    isDemo: boolean;
  } | null;
  technicalIssues: {
    ruleId: string;
    title: string;
    category: string;
    severity: IssueSeverity;
    count: number;
    fix: string;
  }[];
  urlFindings: { url: string; issues: { title: string; severity: IssueSeverity }[] }[];
  visibility: (VisibilitySummary & { providerFilter: string }) | null;
  promptObservations: {
    prompt: string;
    observations: number;
    mentionRate: number | null;
    citationRate: number | null;
    providers: string[];
    latestExcerpt: string | null;
    latestIsDemo: boolean;
  }[];
  citationSources: { domain: string; citations: number; share: number }[];
  competitors: { entities: EntityComparison[] } | null;
  keywordOpportunities: { phrase: string; intent: string | null; priority: string; status: string }[];
  gaps: { prompt: string; gapRate: number; competitors: string[] }[];
  completedWork: {
    recommendations: { title: string; completedAt: string }[];
    content: { title: string; status: string; at: string }[];
    resolvedIssues: number;
  };
  nextSteps: { title: string; severity: IssueSeverity; benefit: string; fix: string }[];
  limitations: string[];
}

export interface BuildReportOptions {
  reportId: string;
}

const SEVERITY_ORDER: IssueSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

export async function buildReportData(
  prisma: PrismaClient,
  { reportId }: BuildReportOptions,
): Promise<ReportData> {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    include: { project: true, workspace: true },
  });
  const sections = (Array.isArray(report.sections) ? report.sections : []) as ReportSection[];
  const want = (s: ReportSection) => sections.includes(s);
  const from = report.dateFrom;
  const to = report.dateTo;
  const providerFilter = ((report.summary as { provider?: string } | null)?.provider ?? 'all') as
    VisibilityProviderKey | 'all';
  const limitations: string[] = [];
  const project = report.project;

  const whiteLabel = (report.whiteLabel ?? null) as {
    enabled?: boolean;
    brandName?: string;
    accentColor?: string;
  } | null;
  const branding = whiteLabel?.enabled
    ? {
        name: whiteLabel.brandName ?? report.workspace.name,
        accentColor: whiteLabel.accentColor ?? '#4f46e5',
        whiteLabel: true,
      }
    : { name: 'Surfaced', accentColor: '#4f46e5', whiteLabel: false };

  // ---------- Audit ----------
  let audit: ReportData['audit'] = null;
  let auditRunId: string | null = null;
  if (want('audit_summary') || want('technical_issues') || want('url_findings')) {
    const run =
      (await prisma.auditRun.findFirst({
        where: { projectId: project.id, status: 'SUCCEEDED', finishedAt: { gte: from, lte: to } },
        orderBy: { finishedAt: 'desc' },
        include: { crawlJob: true },
      })) ??
      (await prisma.auditRun.findFirst({
        where: { projectId: project.id, status: 'SUCCEEDED', finishedAt: { lte: to } },
        orderBy: { finishedAt: 'desc' },
        include: { crawlJob: true },
      }));
    if (!run) {
      limitations.push('No completed website audit exists for this period, so audit sections are empty.');
    } else {
      auditRunId = run.id;
      if (run.finishedAt && run.finishedAt < from)
        limitations.push(
          `No audit finished inside the period; the most recent earlier audit (${run.finishedAt.toISOString().slice(0, 10)}) is shown.`,
        );
      const previous = await prisma.auditRun.findFirst({
        where: { projectId: project.id, status: 'SUCCEEDED', createdAt: { lt: run.createdAt } },
        orderBy: { createdAt: 'desc' },
        select: { score: true },
      });
      const counts = (run.issueCounts ?? {}) as {
        total?: number;
        bySeverity?: Record<IssueSeverity, number>;
      };
      const categoryScores = (run.categoryScores ?? {}) as Record<AuditCategory, number>;
      audit = {
        runId: run.id,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        score: run.score,
        previousScore: previous?.score ?? null,
        categoryScores: AUDIT_CATEGORIES.map((c) => ({
          category: c,
          label: AUDIT_CATEGORY_LABELS[c],
          score: categoryScores[c] ?? 0,
        })),
        issueCounts: {
          total: counts.total ?? 0,
          bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, ...(counts.bySeverity ?? {}) },
        },
        pagesCrawled: run.crawlJob.pagesCrawled,
        startUrl: run.crawlJob.startUrl,
        isDemo: run.isDemo,
      };
      if (run.isDemo) limitations.push('The audit shown is development seed data.');
    }
  }

  const technicalIssues: ReportData['technicalIssues'] = [];
  const urlFindings: ReportData['urlFindings'] = [];
  if (auditRunId && (want('technical_issues') || want('url_findings'))) {
    const occurrences = await prisma.auditIssueOccurrence.findMany({
      where: { auditRunId },
      include: {
        issue: {
          select: {
            ruleId: true,
            title: true,
            category: true,
            severity: true,
            url: true,
            suggestedFix: true,
          },
        },
      },
      take: 20_000,
    });
    const byRule = new Map<string, ReportData['technicalIssues'][number]>();
    const byUrl = new Map<string, { title: string; severity: IssueSeverity }[]>();
    for (const o of occurrences) {
      const issue = o.issue;
      const entry = byRule.get(issue.ruleId) ?? {
        ruleId: issue.ruleId,
        title: issue.title,
        category: AUDIT_CATEGORY_LABELS[issue.category],
        severity: issue.severity,
        count: 0,
        fix: getAuditRule(issue.ruleId)?.fix ?? issue.suggestedFix,
      };
      entry.count += 1;
      byRule.set(issue.ruleId, entry);
      if (issue.url)
        byUrl.set(issue.url, [
          ...(byUrl.get(issue.url) ?? []),
          { title: issue.title, severity: issue.severity },
        ]);
    }
    technicalIssues.push(
      ...[...byRule.values()].sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || b.count - a.count,
      ),
    );
    const weight = (list: { severity: IssueSeverity }[]) =>
      list.reduce((sum, i) => sum + (4 - SEVERITY_ORDER.indexOf(i.severity)), 0);
    urlFindings.push(
      ...[...byUrl.entries()]
        .sort((a, b) => weight(b[1]) - weight(a[1]))
        .slice(0, 50)
        .map(([url, issues]) => ({
          url,
          issues: issues.sort(
            (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
          ),
        })),
    );
  }

  // ---------- AI visibility ----------
  const filter = { provider: providerFilter, from, to };
  let visibility: ReportData['visibility'] = null;
  const promptObservations: ReportData['promptObservations'] = [];
  let citationSources: ReportData['citationSources'] = [];
  if (want('ai_visibility') || want('prompt_observations') || want('citation_sources')) {
    const summary = await getVisibilitySummary(prisma, project.id, filter);
    if (summary.metrics.totals.observations === 0) {
      limitations.push('No AI visibility observations were recorded in this period.');
    } else {
      visibility = { ...summary, providerFilter };
      limitations.push(...summary.notes);
      citationSources = summary.metrics.sources
        .slice(0, 20)
        .map((s) => ({ domain: s.domain, citations: s.citations, share: s.share }));
    }
    if (want('prompt_observations') && summary.metrics.totals.observations > 0) {
      const prompts = await prisma.aiPrompt.findMany({
        where: { projectId: project.id },
        select: { id: true, text: true },
      });
      for (const prompt of prompts) {
        const obs = await prisma.aiVisibilityObservation.findMany({
          where: {
            promptId: prompt.id,
            observedAt: { gte: from, lte: to },
            ...(providerFilter !== 'all' ? { provider: providerFilter } : {}),
          },
          orderBy: { observedAt: 'desc' },
          select: {
            status: true,
            brandMentioned: true,
            brandCited: true,
            provider: true,
            answerText: true,
            isDemo: true,
          },
          take: 500,
        });
        if (!obs.length) continue;
        const ok = obs.filter((o) => o.status === 'SUCCEEDED');
        promptObservations.push({
          prompt: prompt.text,
          observations: obs.length,
          mentionRate: ok.length ? ok.filter((o) => o.brandMentioned).length / ok.length : null,
          citationRate: ok.length ? ok.filter((o) => o.brandCited).length / ok.length : null,
          providers: [...new Set(obs.map((o) => o.provider))],
          latestExcerpt: ok[0]?.answerText ? ok[0].answerText.replace(/\s+/g, ' ').slice(0, 320) : null,
          latestIsDemo: ok[0]?.isDemo ?? false,
        });
      }
    }
  }

  // ---------- Competitors ----------
  let competitors: ReportData['competitors'] = null;
  if (want('competitor_comparison')) {
    const comparison = await competitorComparison(prisma, project.id, filter);
    if (comparison.entities.length <= 1)
      limitations.push('No competitors are configured, so the competitor comparison is empty.');
    else if (comparison.observationCount === 0)
      limitations.push('No AI observations in this period to compare competitors.');
    else competitors = { entities: comparison.entities };
  }

  // ---------- Keywords & gaps ----------
  const keywordOpportunities: ReportData['keywordOpportunities'] = [];
  let gaps: ReportData['gaps'] = [];
  if (want('keyword_opportunities')) {
    const keywords = await prisma.projectKeyword.findMany({
      where: { projectId: project.id, status: { in: ['IDEA', 'PLANNED'] } },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      take: 30,
      select: { phrase: true, intent: true, priority: true, status: true },
    });
    keywordOpportunities.push(...keywords);
    gaps = (await topicGaps(prisma, project.id, filter)).slice(0, 15).map((g) => ({
      prompt: g.prompt,
      gapRate: g.gapRate,
      competitors: g.competitorsMentioned.map((c) => c.name),
    }));
    if (!keywords.length && !gaps.length)
      limitations.push('No keyword ideas or AI answer gaps were found for this period.');
  }

  // ---------- Completed work & next steps ----------
  const completedWork: ReportData['completedWork'] = { recommendations: [], content: [], resolvedIssues: 0 };
  if (want('completed_work')) {
    const [recs, docs, resolved] = await Promise.all([
      prisma.recommendation.findMany({
        where: { projectId: project.id, status: 'COMPLETED', completedAt: { gte: from, lte: to } },
        select: { title: true, completedAt: true },
        take: 50,
      }),
      prisma.contentDocument.findMany({
        where: {
          projectId: project.id,
          OR: [{ approvedAt: { gte: from, lte: to } }, { publishedAt: { gte: from, lte: to } }],
        },
        select: { title: true, status: true, approvedAt: true, publishedAt: true },
        take: 50,
      }),
      prisma.auditIssue.count({
        where: { projectId: project.id, status: 'RESOLVED', resolvedAt: { gte: from, lte: to } },
      }),
    ]);
    completedWork.recommendations = recs.map((r) => ({
      title: r.title,
      completedAt: r.completedAt!.toISOString(),
    }));
    completedWork.content = docs.map((d) => ({
      title: d.title,
      status: d.status,
      at: (d.publishedAt ?? d.approvedAt)!.toISOString(),
    }));
    completedWork.resolvedIssues = resolved;
  }
  const nextSteps: ReportData['nextSteps'] = [];
  if (want('next_steps')) {
    const open = await prisma.recommendation.findMany({
      where: { projectId: project.id, status: { in: [...RECOMMENDATION_OPEN_STATUSES] } },
      orderBy: [{ severity: 'asc' }, { updatedAt: 'desc' }],
      take: 10,
    });
    nextSteps.push(
      ...open.map((r) => ({
        title: r.title,
        severity: r.severity,
        benefit: r.expectedBenefit,
        fix: r.proposedFix,
      })),
    );
    if (!open.length)
      limitations.push(
        'There are no open recommendations; regenerate them after a new audit or visibility run.',
      );
  }
  if (project.isDemo)
    limitations.unshift('This project contains development seed data and demo observations.');

  return {
    title: report.title,
    generatedAt: new Date().toISOString(),
    period: { from: from.toISOString(), to: to.toISOString() },
    project: {
      name: project.name,
      websiteUrl: project.websiteUrl,
      domain: project.domain,
      isDemo: project.isDemo,
    },
    branding,
    sections,
    sectionLabels: REPORT_SECTION_LABELS,
    audit,
    technicalIssues,
    urlFindings,
    visibility,
    promptObservations,
    citationSources,
    competitors,
    keywordOpportunities,
    gaps,
    completedWork,
    nextSteps,
    limitations: [...new Set(limitations)],
  };
}
