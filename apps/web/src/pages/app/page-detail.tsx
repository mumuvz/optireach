import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { useProject } from '@/app/project-scope';
import { PageHeader } from '@/components/app/page';
import { Badge, SeverityBadge } from '@/components/ui/badge';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatBytes, formatDuration, formatNumber, urlPath } from '@/lib/format';
import type { IssueDto } from '@/lib/types';

interface PageDetailDto {
  page: {
    id: string;
    url: string;
    finalUrl: string | null;
    depth: number;
    source: string;
    statusCode: number | null;
    contentType: string | null;
    responseTimeMs: number | null;
    contentLength: number | null;
    redirectChain: { url: string; statusCode: number }[] | null;
    isIndexable: boolean;
    indexabilityReason: string | null;
    title: string | null;
    metaDescription: string | null;
    canonicalUrl: string | null;
    metaRobots: string | null;
    xRobotsTag: string | null;
    lang: string | null;
    h1: string | null;
    h1Count: number;
    headings: { level: number; text: string }[] | null;
    wordCount: number | null;
    imagesTotal: number | null;
    imagesMissingAlt: number | null;
    internalLinksOut: number | null;
    externalLinksOut: number | null;
    inlinksCount: number;
    structuredData: unknown;
    inSitemap: boolean;
    fetchError: string | null;
  };
  issues: IssueDto[];
  inlinks: { pageId: string; url: string; anchorText: string | null; nofollow: boolean }[];
  outlinks: { toUrl: string; anchorText: string | null; nofollow: boolean }[];
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

const missing = <span className="text-muted-foreground">Not set</span>;

export default function PageDetailPage() {
  const project = useProject();
  const { auditId, pageId } = useParams();
  const query = useQuery({
    queryKey: ['audit-page', auditId, pageId],
    queryFn: () => api.get<PageDetailDto>(`/audits/${auditId}/pages/${pageId}`),
  });
  if (query.isPending) return <LoadingBlock rows={8} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const { page, issues, inlinks, outlinks } = query.data;
  const structured = (page.structuredData ?? null) as {
    types?: string[];
    blocks?: number;
    errors?: { index: number; message: string }[];
  } | null;
  const types = structured?.types ?? [];
  const jsonLdErrors = structured?.errors ?? [];
  return (
    <>
      <PageHeader
        title={urlPath(page.url)}
        documentTitle="Page detail"
        breadcrumbs={[
          { label: 'Website audit', to: `/app/p/${project.id}/audits` },
          { label: 'Audit', to: `/app/p/${project.id}/audits/${auditId}` },
          { label: 'Page' },
        ]}
        description={
          <a
            href={page.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="inline-flex items-center gap-1 break-all hover:text-foreground"
          >
            {page.url} <ExternalLink className="size-3 shrink-0" aria-hidden />
          </a>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1.3fr_1fr]">
        <Card>
          <CardHeaderRow title="Fetched data" />
          <CardContent>
            <dl className="divide-y divide-border">
              <Row label="Status">
                <span className="flex flex-wrap gap-1.5">
                  <Badge
                    tone={
                      page.statusCode === null || page.statusCode >= 400
                        ? 'danger'
                        : page.statusCode >= 300
                          ? 'warning'
                          : 'success'
                    }
                  >
                    {page.statusCode ?? 'Fetch failed'}
                  </Badge>
                  <Badge tone={page.isIndexable ? 'success' : 'neutral'}>
                    {page.isIndexable
                      ? 'Indexable'
                      : `Not indexable${page.indexabilityReason ? `: ${page.indexabilityReason}` : ''}`}
                  </Badge>
                  {page.inSitemap ? <Badge tone="info">In sitemap</Badge> : null}
                </span>
                {page.fetchError ? <p className="mt-1 text-destructive">{page.fetchError}</p> : null}
              </Row>
              {page.redirectChain?.length ? (
                <Row label="Redirects">
                  <ol className="space-y-0.5 font-mono text-xs">
                    {page.redirectChain.map((hop) => (
                      <li key={hop.url}>
                        {hop.statusCode} {hop.url}
                      </li>
                    ))}
                    <li>→ {page.finalUrl}</li>
                  </ol>
                </Row>
              ) : null}
              <Row label="Title">{page.title ?? missing}</Row>
              <Row label="Meta description">{page.metaDescription ?? missing}</Row>
              <Row label="H1">
                {page.h1 ? `${page.h1}${page.h1Count > 1 ? ` (+${page.h1Count - 1} more)` : ''}` : missing}
              </Row>
              <Row label="Canonical">
                {page.canonicalUrl ? <span className="font-mono text-xs">{page.canonicalUrl}</span> : missing}
              </Row>
              <Row label="Robots directives">
                {[page.metaRobots, page.xRobotsTag ? `X-Robots-Tag: ${page.xRobotsTag}` : null]
                  .filter(Boolean)
                  .join(' · ') || missing}
              </Row>
              <Row label="Language">{page.lang ?? missing}</Row>
              <Row label="Structured data">
                {types.length ? types.join(', ') : 'None found'}
                {jsonLdErrors.length ? (
                  <p className="mt-1 text-destructive">
                    {jsonLdErrors.length} JSON-LD block(s) could not be parsed: {jsonLdErrors[0]?.message}
                  </p>
                ) : null}
              </Row>
              <Row label="Response">
                {formatDuration(page.responseTimeMs)} · {formatBytes(page.contentLength)} ·{' '}
                {page.contentType ?? 'unknown type'}
              </Row>
              <Row label="Content">
                {formatNumber(page.wordCount)} words · {formatNumber(page.imagesTotal)} images (
                {formatNumber(page.imagesMissingAlt)} without alt text)
              </Row>
              <Row label="Links">
                {formatNumber(page.inlinksCount)} pages link here · {formatNumber(page.internalLinksOut)}{' '}
                internal and {formatNumber(page.externalLinksOut)} external links out · depth {page.depth}
              </Row>
            </dl>
          </CardContent>
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeaderRow title={`Issues on this page (${issues.length})`} />
            <CardContent>
              {issues.length ? (
                <ul className="space-y-3">
                  {issues.map((i) => (
                    <li key={i.id}>
                      <Link
                        to={`/app/p/${project.id}/issues/${i.id}`}
                        className="flex items-start gap-2 text-sm hover:text-primary"
                      >
                        <SeverityBadge severity={i.severity} />
                        <span>{i.title}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No issues were detected on this page.</p>
              )}
            </CardContent>
          </Card>
          {page.headings?.length ? (
            <Card>
              <CardHeaderRow title="Heading outline" />
              <CardContent>
                <ol className="space-y-1 text-sm">
                  {page.headings.slice(0, 40).map((h, idx) => (
                    <li key={idx} style={{ paddingLeft: `${(h.level - 1) * 12}px` }} className="truncate">
                      <span className="mr-1.5 font-mono text-xs text-muted-foreground">H{h.level}</span>
                      {h.text}
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeaderRow title={`Pages linking here (${inlinks.length}${inlinks.length >= 50 ? '+' : ''})`} />
          {inlinks.length ? (
            <Table>
              <THead>
                <TR>
                  <TH>From</TH>
                  <TH>Anchor text</TH>
                </TR>
              </THead>
              <TBody>
                {inlinks.map((l, i) => (
                  <TR key={`${l.pageId}-${i}`}>
                    <TD className="max-w-[18rem]">
                      <Link
                        to={`/app/p/${project.id}/audits/${auditId}/pages/${l.pageId}`}
                        className="block truncate font-mono text-xs hover:text-primary"
                      >
                        {urlPath(l.url)}
                      </Link>
                    </TD>
                    <TD className="text-xs">
                      {l.anchorText || <span className="text-muted-foreground">(no text)</span>}
                      {l.nofollow ? <Badge className="ml-1.5">nofollow</Badge> : null}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          ) : (
            <CardContent>
              <p className="text-sm text-muted-foreground">
                No crawled page links here{page.inSitemap ? ' (found through the sitemap only)' : ''}.
              </p>
            </CardContent>
          )}
        </Card>
        <Card>
          <CardHeaderRow title={`Internal links on this page (${outlinks.length})`} />
          {outlinks.length ? (
            <div className="max-h-96 overflow-y-auto">
              <Table>
                <THead>
                  <TR>
                    <TH>To</TH>
                    <TH>Anchor text</TH>
                  </TR>
                </THead>
                <TBody>
                  {outlinks.map((l, i) => (
                    <TR key={`${l.toUrl}-${i}`}>
                      <TD className="max-w-[18rem]">
                        <span className="block truncate font-mono text-xs" title={l.toUrl}>
                          {urlPath(l.toUrl)}
                        </span>
                      </TD>
                      <TD className="text-xs">
                        {l.anchorText || <span className="text-muted-foreground">(no text)</span>}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </div>
          ) : (
            <CardContent>
              <p className="text-sm text-muted-foreground">This page has no internal links.</p>
            </CardContent>
          )}
        </Card>
      </div>
    </>
  );
}
