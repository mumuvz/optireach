import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { KeywordOpportunitiesDto, KeywordOpportunityDto } from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';

const CONFIDENCE: Record<KeywordOpportunityDto['confidence'], { tone: BadgeTone; label: string }> = {
  high: { tone: 'success', label: 'Most signals' },
  medium: { tone: 'warning', label: 'Some signals' },
  low: { tone: 'neutral', label: 'Few signals' },
};

function Signals({ data }: { data: KeywordOpportunitiesDto['signals'] }) {
  const parts = [
    data.trendsReportAt
      ? `Google Trends report ${formatDate(data.trendsReportAt)}`
      : 'no Google Trends report',
    data.searchConsoleRange
      ? `Search Console ${data.searchConsoleRange.start} to ${data.searchConsoleRange.end}`
      : 'Search Console not connected',
    data.measuredMetrics ? 'provider search volumes' : 'no keyword-data provider',
    data.crawlFinishedAt ? `audit ${formatDate(data.crawlFinishedAt)}` : 'no audit yet',
  ];
  return <p className="text-[13px] text-muted-foreground">Signals available: {parts.join(' · ')}.</p>;
}

/** Explainable opportunity scores for the project's keywords, from the signals that exist for each. */
export function KeywordOpportunities() {
  const project = useProject();
  const query = useQuery({
    queryKey: ['keyword-opportunities', project.id],
    queryFn: () => api.get<KeywordOpportunitiesDto>(`/projects/${project.id}/keywords/opportunities`),
  });
  if (query.isPending) return <LoadingBlock rows={6} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const { items, signals, notes } = query.data;
  if (!items.length)
    return (
      <EmptyState
        title="No keywords to score yet"
        description="Add keywords (or save terms from Keyword trends), then come back to see which to work on first."
      />
    );
  return (
    <Card>
      <CardHeaderRow
        title="Opportunities"
        description="Which keywords to work on first, and how. Each score uses only the signals the keyword has; open “Why” to see every part."
        actions={
          <Button asChild size="sm" variant="outline">
            <Link to={`/app/p/${project.id}/trends`}>Keyword trends</Link>
          </Button>
        }
      />
      <CardContent className="grid gap-3">
        <Signals data={signals} />
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <TR>
                <TH>Keyword</TH>
                <TH className="text-right">Score</TH>
                <TH>Next steps</TH>
                <TH>Why</TH>
              </TR>
            </THead>
            <TBody>
              {items.map((item) => (
                <TR key={item.keywordId}>
                  <TD className="align-top">
                    <div className="font-medium">{item.phrase}</div>
                    {item.missing.length ? (
                      <div className="text-xs text-muted-foreground">No data: {item.missing.join(', ')}</div>
                    ) : null}
                  </TD>
                  <TD className="text-right align-top">
                    <div className="text-lg font-semibold tabular-nums">{item.score ?? '—'}</div>
                    <Badge tone={CONFIDENCE[item.confidence].tone}>{CONFIDENCE[item.confidence].label}</Badge>
                  </TD>
                  <TD className="align-top text-sm">
                    <ul className="space-y-1.5">
                      {item.actions.map((a) => (
                        <li key={a.type}>
                          <span className="font-medium">{a.label}</span>
                          <span className="block text-xs text-muted-foreground">
                            {a.reason}
                            {a.targetUrl ? (
                              <>
                                {' '}
                                <a
                                  href={a.targetUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="break-all text-primary hover:underline"
                                >
                                  {a.targetUrl.replace(/^https?:\/\/(www\.)?/, '')}
                                </a>
                              </>
                            ) : null}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </TD>
                  <TD className="align-top text-sm">
                    <details>
                      <summary className="cursor-pointer text-primary">Why</summary>
                      <ul className="mt-2 min-w-64 space-y-2">
                        {item.components.map((c) => (
                          <li key={c.key}>
                            <div className="flex justify-between gap-3">
                              <span className="font-medium">{c.label}</span>
                              <span className="tabular-nums text-muted-foreground">
                                {c.available ? `${c.points}/${c.maxPoints}` : 'no data'}
                              </span>
                            </div>
                            {c.value ? <div className="text-xs">{c.value}</div> : null}
                            <div className="text-xs text-muted-foreground">
                              {c.explanation}
                              {c.source ? ` Source: ${c.source}.` : ''}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
        <ul className="list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
