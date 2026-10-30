// Static, printable report HTML: inline CSS and SVG, no scripts, every value escaped.
import { SEVERITY_LABELS, escapeHtml as e, type IssueSeverity } from '@surfaced/shared';
import type { ReportData } from './data';

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${Math.round(value * 1000) / 10}%`;
const date = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : '—');
const SEVERITY_COLORS: Record<IssueSeverity, string> = {
  CRITICAL: '#b91c1c',
  HIGH: '#c2410c',
  MEDIUM: '#a16207',
  LOW: '#475569',
};

function bar(label: string, value: number, max: number, color: string, suffix = ''): string {
  const width = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0;
  return `<div class="bar"><span class="bar-label">${e(label)}</span><span class="bar-track"><span class="bar-fill" style="width:${width}%;background:${color}"></span></span><span class="bar-value">${e(String(value))}${e(suffix)}</span></div>`;
}

function severityBadge(severity: IssueSeverity): string {
  return `<span class="badge" style="background:${SEVERITY_COLORS[severity]}">${e(SEVERITY_LABELS[severity])}</span>`;
}

function section(id: string, title: string, body: string): string {
  return `<section id="${e(id)}"><h2>${e(title)}</h2>${body}</section>`;
}

function emptyNote(text: string): string {
  return `<p class="muted">${e(text)}</p>`;
}

export function renderReportHtml(data: ReportData): string {
  const accent = /^#[0-9a-f]{6}$/i.test(data.branding.accentColor) ? data.branding.accentColor : '#4f46e5';
  const parts: string[] = [];
  const has = (s: string) => data.sections.includes(s as never);

  if (has('audit_summary')) {
    const a = data.audit;
    parts.push(
      section(
        'audit-summary',
        data.sectionLabels.audit_summary ?? 'Audit summary',
        a
          ? `<div class="kpis">
              <div class="kpi"><div class="kpi-value">${a.score ?? '—'}<small>/100</small></div><div class="kpi-label">Site health index${a.previousScore !== null && a.score !== null ? ` (${a.score - a.previousScore >= 0 ? '+' : ''}${a.score - a.previousScore} vs previous)` : ''}</div></div>
              <div class="kpi"><div class="kpi-value">${a.pagesCrawled}</div><div class="kpi-label">Pages crawled</div></div>
              <div class="kpi"><div class="kpi-value">${a.issueCounts.total}</div><div class="kpi-label">Issues found</div></div>
              <div class="kpi"><div class="kpi-value">${a.issueCounts.bySeverity.CRITICAL + a.issueCounts.bySeverity.HIGH}</div><div class="kpi-label">Critical + high</div></div>
            </div>
            <p class="muted">Audit of ${e(a.startUrl)} finished ${date(a.finishedAt)}. The site health index is a diagnostic score calculated by ${e(data.branding.name)} from the crawled pages; it is not a search-engine ranking score.</p>
            <h3>Category scores</h3>${a.categoryScores.map((c) => bar(c.label, c.score, 100, accent)).join('')}`
          : emptyNote('No completed audit is available for this period.'),
      ),
    );
  }

  if (has('technical_issues')) {
    parts.push(
      section(
        'technical-issues',
        data.sectionLabels.technical_issues ?? 'Technical issues',
        data.technicalIssues.length
          ? `<table><thead><tr><th>Issue</th><th>Category</th><th>Severity</th><th class="num">Affected</th><th>Recommended fix</th></tr></thead><tbody>${data.technicalIssues
              .map(
                (i) =>
                  `<tr><td>${e(i.title)}</td><td>${e(i.category)}</td><td>${severityBadge(i.severity)}</td><td class="num">${i.count}</td><td>${e(i.fix)}</td></tr>`,
              )
              .join('')}</tbody></table>`
          : emptyNote('No technical issues were recorded for the audit in this period.'),
      ),
    );
  }

  if (has('url_findings')) {
    parts.push(
      section(
        'url-findings',
        data.sectionLabels.url_findings ?? 'URL-level findings',
        data.urlFindings.length
          ? `<table><thead><tr><th>URL</th><th>Issues</th></tr></thead><tbody>${data.urlFindings
              .map(
                (u) =>
                  `<tr><td class="url">${e(u.url)}</td><td>${u.issues
                    .slice(0, 6)
                    .map((i) => `${severityBadge(i.severity)} ${e(i.title)}`)
                    .join(
                      '<br>',
                    )}${u.issues.length > 6 ? `<br><span class="muted">+${u.issues.length - 6} more</span>` : ''}</td></tr>`,
              )
              .join(
                '',
              )}</tbody></table><p class="muted">Showing up to 50 URLs with the most severe issues.</p>`
          : emptyNote('No page-level findings for this period.'),
      ),
    );
  }

  if (has('ai_visibility')) {
    const v = data.visibility;
    parts.push(
      section(
        'ai-visibility',
        data.sectionLabels.ai_visibility ?? 'AI visibility',
        v
          ? `<div class="kpis">
              <div class="kpi"><div class="kpi-value">${pct(v.metrics.mentionRate)}</div><div class="kpi-label">Mention rate</div></div>
              <div class="kpi"><div class="kpi-value">${pct(v.metrics.citationRate)}</div><div class="kpi-label">Citation rate (owned domain)</div></div>
              <div class="kpi"><div class="kpi-value">${pct(v.metrics.shareOfVoice.brand)}</div><div class="kpi-label">Share of voice</div></div>
              <div class="kpi"><div class="kpi-value">${v.metrics.totals.successful}</div><div class="kpi-label">Successful observations</div></div>
            </div>
            <p class="muted">Providers: ${e(v.composition.providers.join(', ') || '—')} · Locales: ${e(v.composition.countries.join(', '))} / ${e(v.composition.languages.join(', '))} · Prompts: ${v.composition.promptCount}. Mention rate = answers mentioning the brand ÷ successful answers. Citation rate = answers citing an owned-domain URL ÷ successful answers. Share of voice = brand mentions ÷ (brand + competitor mentions), counting each answer once per entity.</p>
            ${v.metrics.competitors.length ? `<h3>Competitor mention rates</h3>${bar('Your brand', Math.round((v.metrics.mentionRate ?? 0) * 100), 100, accent, '%')}${v.metrics.competitors.map((c) => bar(c.name, Math.round((c.mentionRate ?? 0) * 100), 100, '#64748b', '%')).join('')}` : ''}`
          : emptyNote('No AI visibility observations were recorded in this period.'),
      ),
    );
  }

  if (has('prompt_observations')) {
    parts.push(
      section(
        'prompt-observations',
        data.sectionLabels.prompt_observations ?? 'Prompt-level observations',
        data.promptObservations.length
          ? `<table><thead><tr><th>Prompt</th><th class="num">Answers</th><th class="num">Mentioned</th><th class="num">Cited</th><th>Latest answer (excerpt)</th></tr></thead><tbody>${data.promptObservations
              .map(
                (p) =>
                  `<tr><td>${e(p.prompt)}<br><span class="muted">${e(p.providers.join(', '))}</span></td><td class="num">${p.observations}</td><td class="num">${pct(p.mentionRate)}</td><td class="num">${pct(p.citationRate)}</td><td class="excerpt">${p.latestIsDemo ? '<em>[Demo data]</em> ' : ''}${e(p.latestExcerpt ?? '—')}</td></tr>`,
              )
              .join('')}</tbody></table>`
          : emptyNote('No prompt observations in this period.'),
      ),
    );
  }

  if (has('citation_sources')) {
    const max = Math.max(1, ...data.citationSources.map((s) => s.citations));
    parts.push(
      section(
        'citation-sources',
        data.sectionLabels.citation_sources ?? 'Citation sources',
        data.citationSources.length
          ? data.citationSources.map((s) => bar(s.domain, s.citations, max, accent)).join('')
          : emptyNote('No citations were recorded in this period.'),
      ),
    );
  }

  if (has('competitor_comparison')) {
    parts.push(
      section(
        'competitors',
        data.sectionLabels.competitor_comparison ?? 'Competitor comparison',
        data.competitors
          ? `<table><thead><tr><th>Entity</th><th class="num">Mention rate</th><th class="num">Citation rate</th><th class="num">Share of voice</th><th class="num">Avg. position</th></tr></thead><tbody>${data.competitors.entities
              .map(
                (c) =>
                  `<tr${c.isBrand ? ' class="brand"' : ''}><td>${e(c.name)}<br><span class="muted">${e(c.domain ?? 'no website')}</span></td><td class="num">${pct(c.mentionRate)}</td><td class="num">${pct(c.citationRate)}</td><td class="num">${pct(c.shareOfVoice)}</td><td class="num">${c.averageRank ?? '—'}</td></tr>`,
              )
              .join(
                '',
              )}</tbody></table><p class="muted">Based only on observed AI answers. No competitor traffic, rankings or private data are estimated.</p>`
          : emptyNote('Not enough data for a competitor comparison in this period.'),
      ),
    );
  }

  if (has('keyword_opportunities')) {
    parts.push(
      section(
        'keywords',
        data.sectionLabels.keyword_opportunities ?? 'Keyword opportunities',
        `${data.keywordOpportunities.length ? `<table><thead><tr><th>Keyword</th><th>Intent</th><th>Priority</th><th>Status</th></tr></thead><tbody>${data.keywordOpportunities.map((k) => `<tr><td>${e(k.phrase)}</td><td>${e(k.intent ?? '—')}</td><td>${e(k.priority)}</td><td>${e(k.status)}</td></tr>`).join('')}</tbody></table>` : emptyNote('No keyword ideas are planned yet.')}
         ${data.gaps.length ? `<h3>AI answer gaps</h3><ul>${data.gaps.map((g) => `<li>${e(g.prompt)} — competitors present without your brand in ${pct(g.gapRate)} of answers (${e(g.competitors.join(', '))})</li>`).join('')}</ul>` : ''}
         <p class="muted">Search volume and difficulty are not shown because no licensed keyword-data provider is connected.</p>`,
      ),
    );
  }

  if (has('completed_work')) {
    const w = data.completedWork;
    parts.push(
      section(
        'completed',
        data.sectionLabels.completed_work ?? 'Completed work',
        `<p>${w.resolvedIssues} audit issue(s) resolved in this period.</p>
         ${w.recommendations.length ? `<h3>Recommendations completed</h3><ul>${w.recommendations.map((r) => `<li>${e(r.title)} <span class="muted">(${date(r.completedAt)})</span></li>`).join('')}</ul>` : ''}
         ${w.content.length ? `<h3>Content approved or published</h3><ul>${w.content.map((c) => `<li>${e(c.title)} — ${e(c.status.toLowerCase())} <span class="muted">(${date(c.at)})</span></li>`).join('')}</ul>` : ''}`,
      ),
    );
  }

  if (has('next_steps')) {
    parts.push(
      section(
        'next-steps',
        data.sectionLabels.next_steps ?? 'Next steps',
        data.nextSteps.length
          ? `<ol>${data.nextSteps.map((s) => `<li><strong>${e(s.title)}</strong> ${severityBadge(s.severity)}<br>${e(s.fix)}<br><span class="muted">${e(s.benefit)}</span></li>`).join('')}</ol>`
          : emptyNote('No open recommendations.'),
      ),
    );
  }

  const limitations = data.limitations.length
    ? `<section class="limitations"><h2>Data limitations</h2><ul>${data.limitations.map((l) => `<li>${e(l)}</li>`).join('')}</ul></section>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${e(data.title)}</title>
<style>
  :root { --accent: ${accent}; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif; color: #0f172a; background: #fff; font-size: 13px; line-height: 1.5; }
  main { max-width: 960px; margin: 0 auto; padding: 32px 24px; }
  header { border-bottom: 3px solid var(--accent); padding-bottom: 16px; margin-bottom: 24px; }
  header .brand { font-weight: 700; color: var(--accent); letter-spacing: .02em; }
  h1 { font-size: 24px; margin: 8px 0 4px; }
  h2 { font-size: 17px; margin: 0 0 12px; padding-top: 8px; }
  h3 { font-size: 14px; margin: 16px 0 8px; }
  section { margin-bottom: 28px; page-break-inside: avoid; }
  .muted { color: #64748b; font-size: 12px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 12px; }
  .kpi { border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; }
  .kpi-value { font-size: 22px; font-weight: 700; }
  .kpi-value small { font-size: 12px; color: #64748b; font-weight: 500; }
  .kpi-label { color: #475569; font-size: 12px; }
  .bar { display: grid; grid-template-columns: 200px 1fr 60px; align-items: center; gap: 8px; margin: 4px 0; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { background: #f1f5f9; border-radius: 4px; height: 10px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; border-radius: 4px; }
  .bar-value { text-align: right; font-variant-numeric: tabular-nums; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.url { word-break: break-all; max-width: 320px; }
  td.excerpt { color: #334155; max-width: 360px; }
  tr.brand td { background: #eef2ff; font-weight: 600; }
  .badge { display: inline-block; color: #fff; border-radius: 999px; padding: 0 8px; font-size: 11px; line-height: 18px; }
  .limitations { background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 12px 16px; }
  footer { margin-top: 32px; color: #94a3b8; font-size: 11px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
  @media print { main { padding: 0; } a { color: inherit; } }
  @media (max-width: 720px) { .kpis { grid-template-columns: repeat(2, 1fr); } .bar { grid-template-columns: 120px 1fr 48px; } }
</style>
</head>
<body>
<main>
<header>
  <div class="brand">${e(data.branding.name)}</div>
  <h1>${e(data.title)}</h1>
  <div class="muted">${e(data.project.name)}${data.project.websiteUrl ? ` · ${e(data.project.websiteUrl)}` : ''} · ${date(data.period.from)} to ${date(data.period.to)} · generated ${date(data.generatedAt)}</div>
</header>
${limitations}
${parts.join('\n')}
<footer>Generated by ${e(data.branding.name)} from stored audit and AI visibility data. Metrics describe observed behaviour during the period and are not guarantees of future rankings or AI recommendations.</footer>
</main>
</body>
</html>`;
}
