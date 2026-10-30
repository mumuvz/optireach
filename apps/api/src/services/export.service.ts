import { competitorComparison } from '@surfaced/core/competitors';
import type { PrismaClient } from '@surfaced/core/db';
import { Errors } from '@surfaced/core/errors';
import {
  PdfUnavailableError,
  renderModulePdf,
  type PdfDocument,
  type PdfSection,
} from '@surfaced/core/reports';
import { getVisibilitySummary } from '@surfaced/core/visibility';
import {
  AUDIT_CATEGORY_LABELS,
  CONTENT_STATUS_LABELS,
  RECOMMENDATION_CATEGORY_LABELS,
  SEARCH_INTENT_LABELS,
  SEVERITY_LABELS,
  slugify,
  type AuditCategory,
  type IssueSeverity,
} from '@surfaced/shared';
import type { AppDeps, AuthUser } from '../types';
import { requireProjectAccess } from './access';

export const EXPORTABLE_MODULES = [
  'audit',
  'visibility',
  'competitors',
  'keywords',
  'recommendations',
  'content',
  'answerability',
  'trends',
] as const;
export type ExportableModule = (typeof EXPORTABLE_MODULES)[number];

const MODULE_TITLES: Record<ExportableModule, string> = {
  audit: 'Website audit',
  visibility: 'AI visibility',
  competitors: 'Competitor comparison',
  keywords: 'Keyword research',
  recommendations: 'Recommendations',
  content: 'Content studio',
  answerability: 'Answerability (AEO)',
  trends: 'Keyword trends',
};

const pct = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `${Math.round(n * 1000) / 10}%`;
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

export class ExportService {
  constructor(private readonly deps: AppDeps) {}

  private get prisma(): PrismaClient {
    return this.deps.prisma;
  }

  async pdf(user: AuthUser, projectId: string, module: string): Promise<{ filename: string; buffer: Buffer }> {
    if (!EXPORTABLE_MODULES.includes(module as ExportableModule)) throw Errors.notFound('Export');
    const { project } = await requireProjectAccess(this.prisma, user, projectId, 'project.read');
    const { sections, limitations } = await this.build(module as ExportableModule, projectId);
    const doc: PdfDocument = {
      title: `${MODULE_TITLES[module as ExportableModule]} — ${project.name}`,
      brand: { name: 'Surfaced', accentColor: '#4f46e5' },
      project: { name: project.name, websiteUrl: project.websiteUrl },
      generatedAt: new Date().toISOString(),
      subtitle: MODULE_TITLES[module as ExportableModule],
      limitations,
      sections,
    };
    try {
      const buffer = await renderModulePdf(doc);
      return { filename: `${slugify(project.name) || 'project'}-${module}.pdf`, buffer };
    } catch (error) {
      if (error instanceof PdfUnavailableError)
        throw Errors.unavailable(`PDF export is not available on this server. ${error.message}`);
      throw error;
    }
  }

  private async build(
    module: ExportableModule,
    projectId: string,
  ): Promise<{ sections: PdfSection[]; limitations: string[] }> {
    switch (module) {
      case 'audit':
        return this.audit(projectId);
      case 'visibility':
        return this.visibility(projectId);
      case 'competitors':
        return this.competitors(projectId);
      case 'keywords':
        return this.keywords(projectId);
      case 'recommendations':
        return this.recommendations(projectId);
      case 'content':
        return this.content(projectId);
      case 'answerability':
        return this.answerability(projectId);
      case 'trends':
        return this.trends(projectId);
    }
  }

  private async audit(projectId: string) {
    const run = await this.prisma.auditRun.findFirst({
      where: { projectId, status: 'SUCCEEDED' },
      orderBy: { finishedAt: 'desc' },
      include: { crawlJob: { select: { startUrl: true } } },
    });
    if (!run)
      return { sections: [textSection('No completed audit', 'Run a website audit to export its results.')], limitations: [] }; // prettier-ignore
    const counts = (run.issueCounts ?? {}) as {
      total?: number;
      bySeverity?: Partial<Record<IssueSeverity, number>>;
    };
    const cat = (run.categoryScores ?? {}) as Partial<Record<AuditCategory, number>>;
    const issues = await this.prisma.auditIssue.findMany({
      where: { projectId, status: 'OPEN' },
      orderBy: [{ severity: 'asc' }, { lastDetectedAt: 'desc' }],
      select: { title: true, category: true, severity: true },
      take: 25,
    });
    const crit = (counts.bySeverity?.CRITICAL ?? 0) + (counts.bySeverity?.HIGH ?? 0);
    return {
      sections: [
        {
          heading: 'Summary',
          type: 'kpis',
          kpis: [
            { label: 'Site health index', value: `${run.score ?? '—'}/100` },
            { label: 'Pages analyzed', value: String(run.pagesAnalyzed ?? '—') },
            { label: 'Issues found', value: String(counts.total ?? 0) },
            { label: 'Critical + high', value: String(crit) },
          ],
          note: `Audit of ${run.crawlJob.startUrl} finished ${day(run.finishedAt)}. The site health index is a diagnostic score, not a search-engine ranking.`,
        },
        {
          heading: 'Category scores',
          type: 'table',
          table: {
            columns: ['Category', 'Score'],
            numericColumns: [1],
            rows: Object.entries(cat).map(([k, v]) => [
              AUDIT_CATEGORY_LABELS[k as AuditCategory] ?? k,
              `${v}/100`,
            ]),
          },
        },
        {
          heading: 'Open issues',
          type: 'table',
          table: {
            columns: ['Issue', 'Category', 'Severity'],
            rows: issues.map((i) => [
              i.title,
              AUDIT_CATEGORY_LABELS[i.category] ?? i.category,
              SEVERITY_LABELS[i.severity],
            ]),
            note: issues.length === 25 ? 'Showing the 25 most severe open issues.' : undefined,
          },
        },
      ] satisfies PdfSection[],
      limitations: [],
    };
  }

  private async visibility(projectId: string) {
    const summary = await getVisibilitySummary(this.prisma, projectId, {});
    const m = summary.metrics;
    return {
      sections: [
        {
          heading: 'Summary',
          type: 'kpis',
          kpis: [
            { label: 'Mention rate', value: pct(m.mentionRate) },
            { label: 'Citation rate', value: pct(m.citationRate) },
            { label: 'Share of voice', value: pct(m.shareOfVoice.brand) },
            { label: 'Successful observations', value: String(m.totals.successful) },
          ],
          note: 'Rates are over successful AI answers only. No traffic or ranking is estimated.',
        },
        {
          heading: 'Competitor mention rates',
          type: 'table',
          table: {
            columns: ['Entity', 'Mention rate'],
            numericColumns: [1],
            rows: [
              ['Your brand', pct(m.mentionRate)],
              ...m.competitors.map((c) => [c.name, pct(c.mentionRate)] as [string, string]),
            ],
          },
        },
      ] satisfies PdfSection[],
      limitations: summary.notes,
    };
  }

  private async competitors(projectId: string) {
    const comparison = await competitorComparison(this.prisma, projectId, {});
    return {
      sections: [
        {
          heading: 'Comparison',
          type: 'table',
          table: {
            columns: ['Entity', 'Mention rate', 'Citation rate', 'Share of voice', 'Avg. position'],
            numericColumns: [1, 2, 3, 4],
            rows: comparison.entities.map((c) => [
              c.isBrand ? `${c.name} (you)` : c.name,
              pct(c.mentionRate),
              pct(c.citationRate),
              pct(c.shareOfVoice),
              c.averageRank ?? '—',
            ]),
            note: 'Based only on observed AI answers. No competitor traffic, rankings or private data are estimated.',
          },
        },
      ] satisfies PdfSection[],
      limitations: [],
    };
  }

  private async keywords(projectId: string) {
    const rows = await this.prisma.projectKeyword.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { phrase: true, intent: true, priority: true, status: true },
      take: 100,
    });
    return {
      sections: [
        {
          heading: 'Keywords',
          type: 'kpis',
          kpis: [{ label: 'Tracked keywords', value: String(rows.length) }],
        },
        {
          heading: 'List',
          type: 'table',
          table: {
            columns: ['Keyword', 'Intent', 'Priority', 'Status'],
            rows: rows.map((k) => [
              k.phrase,
              k.intent ? (SEARCH_INTENT_LABELS[k.intent] ?? k.intent) : '—',
              k.priority,
              k.status,
            ]),
            note: rows.length === 100 ? 'Showing the 100 most recent keywords.' : undefined,
          },
        },
      ] satisfies PdfSection[],
      limitations: [
        'Search volume, difficulty and CPC are not shown because no licensed keyword-data provider is connected; they are never estimated.',
      ],
    };
  }

  private async recommendations(projectId: string) {
    const rows = await this.prisma.recommendation.findMany({
      where: { projectId },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      select: { title: true, category: true, severity: true, status: true, ownerRole: true },
      take: 100,
    });
    const byStatus = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      sections: [
        {
          heading: 'Summary',
          type: 'kpis',
          kpis: [
            { label: 'Total', value: String(rows.length) },
            { label: 'Open', value: String(byStatus.OPEN ?? 0) },
            { label: 'In progress', value: String(byStatus.IN_PROGRESS ?? 0) },
            { label: 'Completed', value: String((byStatus.COMPLETED ?? 0) + (byStatus.VERIFIED ?? 0)) },
          ],
        },
        {
          heading: 'Recommendations',
          type: 'table',
          table: {
            columns: ['Recommendation', 'Category', 'Severity', 'Owner', 'Status'],
            rows: rows.map((r) => [
              r.title,
              RECOMMENDATION_CATEGORY_LABELS[r.category] ?? r.category,
              SEVERITY_LABELS[r.severity],
              r.ownerRole ?? '—',
              r.status,
            ]),
          },
        },
      ] satisfies PdfSection[],
      limitations: [],
    };
  }

  private async content(projectId: string) {
    const rows = await this.prisma.contentDocument.findMany({
      where: { projectId },
      orderBy: { updatedAt: 'desc' },
      select: { title: true, status: true, wordCount: true, updatedAt: true },
      take: 100,
    });
    const byStatus = rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    return {
      sections: [
        {
          heading: 'Summary',
          type: 'kpis',
          kpis: [
            { label: 'Documents', value: String(rows.length) },
            { label: 'Draft', value: String(byStatus.DRAFT ?? 0) },
            { label: 'In review', value: String(byStatus.IN_REVIEW ?? 0) },
            { label: 'Published', value: String(byStatus.PUBLISHED ?? 0) },
          ],
        },
        {
          heading: 'Documents',
          type: 'table',
          table: {
            columns: ['Title', 'Status', 'Words', 'Updated'],
            numericColumns: [2],
            rows: rows.map((d) => [
              d.title,
              CONTENT_STATUS_LABELS[d.status] ?? d.status,
              d.wordCount ?? 0,
              day(d.updatedAt),
            ]),
          },
        },
      ] satisfies PdfSection[],
      limitations: [],
    };
  }

  private async answerability(projectId: string) {
    const run = await this.prisma.answerabilityRun.findFirst({
      where: { projectId, status: 'SUCCEEDED' },
      orderBy: { createdAt: 'desc' },
    });
    if (!run)
      return { sections: [textSection('No answerability audit', 'Run an answerability audit to export it.')], limitations: [] }; // prettier-ignore
    const a = (run.assessment ?? {}) as {
      summary?: string;
      findings?: { area: string; status: string; detail: string; recommendation: string }[];
      questionCoverage?: { question: string; covered: boolean; note: string }[];
    };
    const sections: PdfSection[] = [
      {
        heading: 'Summary',
        type: 'kpis',
        kpis: [
          { label: 'Answerability index', value: `${run.score ?? '—'}/100` },
          { label: 'Grade', value: run.grade ?? '—' },
          { label: 'Pages considered', value: String(run.pagesConsidered) },
          { label: 'Questions considered', value: String(run.questionsConsidered) },
        ],
        note: a.summary,
      },
    ];
    if (a.findings?.length)
      sections.push({
        heading: 'Findings and recommendations',
        type: 'table',
        table: {
          columns: ['Area', 'Status', 'Detail', 'Recommendation'],
          rows: a.findings.map((f) => [f.area, f.status, f.detail, f.recommendation]),
        },
      });
    if (a.questionCoverage?.length)
      sections.push({
        heading: 'Question coverage',
        type: 'table',
        table: {
          columns: ['Question', 'Covered', 'Note'],
          rows: a.questionCoverage.map((q) => [q.question, q.covered ? 'Yes' : 'Gap', q.note]),
        },
      });
    return {
      sections,
      limitations: (run.limitations ?? []) as string[],
    };
  }

  private async trends(projectId: string) {
    const rows = await this.prisma.trendReport.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { keywords: true, source: true, status: true, country: true, createdAt: true },
      take: 50,
    });
    return {
      sections: [
        {
          heading: 'Recent trend reports',
          type: 'table',
          table: {
            columns: ['Terms', 'Source', 'Market', 'Status', 'Created'],
            rows: rows.map((r) => [
              (Array.isArray(r.keywords) ? (r.keywords as string[]) : []).join(', '),
              r.source,
              r.country ?? '—',
              r.status,
              day(r.createdAt),
            ]),
          },
        },
      ] satisfies PdfSection[],
      limitations: [
        'Trend values come from the configured trends provider and reflect relative interest, not absolute search volume.',
      ],
    };
  }
}

function textSection(heading: string, text: string): PdfSection {
  return { heading, type: 'text', text };
}
