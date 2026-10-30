// A printable one-module PDF (e.g. "Website audit", "AI visibility"). Unlike the multi-section Report, this is a
// synchronous, single-module export built from a module's current data. It reuses the report's styling and the
// Chromium renderer. Every value is escaped; there are no scripts and no network requests. Renders are serialized
// in-process so a burst of exports never launches many Chromium instances at once.
import { escapeHtml as esc } from '@surfaced/shared';
import { renderPdf } from './pdf';

export interface PdfKpi {
  label: string;
  value: string;
}
export interface PdfTable {
  columns: string[];
  rows: (string | number)[][];
  /** Indexes of columns to right-align as numbers. */
  numericColumns?: number[];
  note?: string;
}
export type PdfSection =
  | { heading: string; type: 'kpis'; kpis: PdfKpi[]; note?: string }
  | { heading: string; type: 'table'; table: PdfTable }
  | { heading: string; type: 'list'; items: string[]; ordered?: boolean }
  | { heading: string; type: 'text'; text: string };

export interface PdfDocument {
  title: string;
  brand: { name: string; accentColor: string };
  project: { name: string; websiteUrl: string | null };
  generatedAt: string;
  subtitle?: string;
  /** Honest notes about what the data does and does not cover. */
  limitations?: string[];
  sections: PdfSection[];
  footer?: string;
}

const date = (iso: string | null | undefined) =>
  iso ? new Date(iso).toISOString().slice(0, 10) : '—';

function renderSection(s: PdfSection): string {
  const body = (() => {
    switch (s.type) {
      case 'kpis':
        return (
          `<div class="kpis">${s.kpis
            .map(
              (k) =>
                `<div class="kpi"><div class="kpi-value">${esc(k.value)}</div><div class="kpi-label">${esc(k.label)}</div></div>`,
            )
            .join('')}</div>` + (s.note ? `<p class="muted">${esc(s.note)}</p>` : '')
        );
      case 'table': {
        const num = new Set(s.table.numericColumns ?? []);
        const head = s.table.columns
          .map((c, i) => `<th${num.has(i) ? ' class="num"' : ''}>${esc(c)}</th>`)
          .join('');
        const rows = s.table.rows.length
          ? s.table.rows
              .map(
                (r) =>
                  `<tr>${r
                    .map((cell, i) => `<td${num.has(i) ? ' class="num"' : ''}>${esc(String(cell))}</td>`)
                    .join('')}</tr>`,
              )
              .join('')
          : `<tr><td class="muted" colspan="${s.table.columns.length}">No data.</td></tr>`;
        return (
          `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>` +
          (s.table.note ? `<p class="muted">${esc(s.table.note)}</p>` : '')
        );
      }
      case 'list': {
        const tag = s.ordered ? 'ol' : 'ul';
        return s.items.length
          ? `<${tag}>${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</${tag}>`
          : `<p class="muted">Nothing to show.</p>`;
      }
      case 'text':
        return `<p>${esc(s.text)}</p>`;
    }
  })();
  return `<section><h2>${esc(s.heading)}</h2>${body}</section>`;
}

export function renderDocumentHtml(doc: PdfDocument): string {
  const accent = /^#[0-9a-f]{6}$/i.test(doc.brand.accentColor) ? doc.brand.accentColor : '#4f46e5';
  const limitations = doc.limitations?.length
    ? `<section class="limitations"><h2>Data notes</h2><ul>${doc.limitations
        .map((l) => `<li>${esc(l)}</li>`)
        .join('')}</ul></section>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(doc.title)}</title>
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
  .kpi-label { color: #475569; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  th { background: #f8fafc; font-weight: 600; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  ul, ol { margin: 0; padding-left: 20px; }
  li { margin: 2px 0; }
  .limitations { background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 12px 16px; }
  footer { margin-top: 32px; color: #94a3b8; font-size: 11px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
  @media print { main { padding: 0; } }
  @media (max-width: 720px) { .kpis { grid-template-columns: repeat(2, 1fr); } }
</style>
</head>
<body>
<main>
<header>
  <div class="brand">${esc(doc.brand.name)}</div>
  <h1>${esc(doc.title)}</h1>
  <div class="muted">${esc(doc.project.name)}${doc.project.websiteUrl ? ` · ${esc(doc.project.websiteUrl)}` : ''}${doc.subtitle ? ` · ${esc(doc.subtitle)}` : ''} · generated ${date(doc.generatedAt)}</div>
</header>
${limitations}
${doc.sections.map(renderSection).join('\n')}
<footer>${esc(doc.footer ?? `Generated by ${doc.brand.name} from stored data. Metrics describe observed data and are not guarantees of future rankings or AI recommendations.`)}</footer>
</main>
</body>
</html>`;
}

// Serialize renders so concurrent exports never launch multiple Chromium instances at once.
let renderChain: Promise<unknown> = Promise.resolve();

/** Builds a module's PDF from a PdfDocument, serialized against other module renders. */
export async function renderModulePdf(doc: PdfDocument): Promise<Buffer> {
  const run = renderChain.then(
    () => renderPdf(renderDocumentHtml(doc)),
    () => renderPdf(renderDocumentHtml(doc)),
  );
  renderChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
