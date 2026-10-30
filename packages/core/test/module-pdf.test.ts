import { describe, expect, it } from 'vitest';
import { renderDocumentHtml, type PdfDocument } from '../src/reports/module-pdf';

const base: PdfDocument = {
  title: 'Website audit — Acme',
  brand: { name: 'Surfaced', accentColor: '#4f46e5' },
  project: { name: 'Acme', websiteUrl: 'https://acme.example.com' },
  generatedAt: '2026-10-26T00:00:00.000Z',
  subtitle: 'Website audit',
  limitations: ['Assessed from stored data only.'],
  sections: [
    {
      heading: 'Summary',
      type: 'kpis',
      kpis: [{ label: 'Site health index', value: '82/100' }],
      note: 'Diagnostic score, not a ranking.',
    },
    {
      heading: 'Open issues',
      type: 'table',
      table: {
        columns: ['Issue', 'Severity'],
        rows: [['Missing meta description', 'Medium']],
      },
    },
    { heading: 'Notes', type: 'list', items: ['First note'] },
  ],
};

describe('module PDF HTML renderer', () => {
  it('renders sections and escapes every value', () => {
    const html = renderDocumentHtml({
      ...base,
      title: 'Audit <script>alert(1)</script>',
      sections: [
        ...base.sections,
        { heading: 'Raw', type: 'text', text: 'a & b < c > "d"' },
      ],
    });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Site health index');
    expect(html).toContain('82/100');
    expect(html).toContain('Missing meta description');
    expect(html).toContain('Assessed from stored data only.');
    // No unescaped script or raw angle brackets from content survive.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &amp; b &lt; c &gt; &quot;d&quot;');
  });

  it('shows an empty-state row for a table with no rows', () => {
    const html = renderDocumentHtml({
      ...base,
      sections: [{ heading: 'Empty', type: 'table', table: { columns: ['A', 'B'], rows: [] } }],
    });
    expect(html).toContain('No data.');
    expect(html).toContain('colspan="2"');
  });
});
