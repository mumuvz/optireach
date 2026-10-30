import { renderMarkdown } from '@surfaced/shared/markdown';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useParams } from 'react-router';
import {
  CAPTURE_METHOD_LABELS,
  countryName,
  languageName,
  observationProviderLabel,
  type CaptureMethod,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { PageHeader } from '@/components/app/page';
import { Badge, EstimateBadge, StatusBadge, humanize } from '@/components/ui/badge';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { Alert, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';

interface ObservationDetailDto {
  id: string;
  provider: string;
  model: string | null;
  country: string;
  city: string | null;
  language: string;
  captureMethod: string;
  limitations: string[] | null;
  note: string | null;
  promptText: string;
  status: string;
  isDemo: boolean;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  rawResponse: unknown;
  answerText: string | null;
  brandMentioned: boolean;
  brandCited: boolean;
  brandRank: number | null;
  sentiment: string | null;
  sentimentSource: string | null;
  sentimentConfidence: number | null;
  latencyMs: number | null;
  observedAt: string;
  prompt: { id: string; text: string };
  mentions: {
    id: string;
    entityType: string;
    entityName: string;
    matchedText: string;
    matchType: string;
    rank: number;
    snippet: string | null;
    confidence: number | null;
  }[];
  citations: {
    id: string;
    url: string;
    domain: string;
    title: string | null;
    position: number;
    sourceType: string;
    isOwnedDomain: boolean;
    competitorId: string | null;
  }[];
}

export default function ObservationPage() {
  const project = useProject();
  const { observationId } = useParams();
  const query = useQuery({
    queryKey: ['observation', observationId],
    queryFn: () => api.get<ObservationDetailDto>(`/ai-visibility/observations/${observationId}`),
  });
  if (query.isPending) return <LoadingBlock rows={8} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const o = query.data;
  const providerLabel = observationProviderLabel(o.provider);
  const competitorName = (id: string | null) => project.competitors.find((c) => c.id === id)?.name;
  return (
    <>
      <PageHeader
        title="Observation"
        breadcrumbs={[
          { label: 'AI visibility', to: `/app/p/${project.id}/visibility?tab=observations` },
          { label: 'Observation' },
        ]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={o.status} />
            <span>{providerLabel}</span>
            {o.model ? <span className="font-mono text-xs">{o.model}</span> : null}
            <span>
              {o.city ? `${o.city}, ` : ''}
              {countryName(o.country)} · {languageName(o.language)}
            </span>
            <span>{formatDateTime(o.observedAt)}</span>
            {o.isDemo ? (
              <Badge tone="demo">Demo data — not a real AI response</Badge>
            ) : (
              <Badge tone={o.captureMethod === 'MANUAL' ? 'info' : 'neutral'}>
                {CAPTURE_METHOD_LABELS[o.captureMethod as CaptureMethod] ?? o.captureMethod}
              </Badge>
            )}
          </span>
        }
      />
      <Card className="mb-5 p-4">
        <p className="text-xs font-medium text-muted-foreground">Prompt</p>
        <p className="mt-1 text-[15px] font-medium">{o.promptText}</p>
        {o.limitations?.length ? (
          <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
            {o.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        ) : null}
        {o.note ? <p className="mt-2 text-xs text-muted-foreground">Note: {o.note}</p> : null}
      </Card>
      {o.status === 'FAILED' ? (
        <Alert
          tone="danger"
          title={`The provider call failed${o.errorCode ? ` (${o.errorCode})` : ''}`}
          className="mb-5"
        >
          {o.errorMessage ?? 'No answer was returned.'} Failed calls are excluded from every rate.{' '}
          {o.attempts > 1 ? `Tried ${o.attempts} times.` : ''}
        </Alert>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr]">
        <Card>
          <CardHeaderRow
            title="Answer"
            description={o.latencyMs ? `Returned in ${formatDuration(o.latencyMs)}` : undefined}
          />
          <CardContent>
            {o.answerText ? (
              <div
                className="prose-content"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(o.answerText) }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">No answer text.</p>
            )}
          </CardContent>
        </Card>
        <div className="space-y-5">
          <Card>
            <CardHeaderRow title="Your brand" />
            <CardContent className="space-y-2 text-sm">
              <p>
                {o.brandMentioned ? (
                  <Badge tone="success">Mentioned{o.brandRank ? ` · position ${o.brandRank}` : ''}</Badge>
                ) : (
                  <Badge>Not mentioned</Badge>
                )}{' '}
                {o.brandCited ? <Badge tone="primary">Your domain is cited</Badge> : <Badge>Not cited</Badge>}
              </p>
              {o.sentiment ? (
                <p className="flex flex-wrap items-center gap-2">
                  Sentiment: <span className="font-medium">{humanize(o.sentiment)}</span>
                  {o.sentimentSource === 'AI_ESTIMATE' ? (
                    <EstimateBadge />
                  ) : (
                    <Badge tone="demo">Demo fixture</Badge>
                  )}
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeaderRow
              title={`Mentions (${o.mentions.length})`}
              description="Matched deterministically on names, aliases and domains"
            />
            {o.mentions.length ? (
              <Table>
                <THead>
                  <TR>
                    <TH>#</TH>
                    <TH>Entity</TH>
                    <TH>Matched</TH>
                  </TR>
                </THead>
                <TBody>
                  {o.mentions.map((m) => (
                    <TR key={m.id}>
                      <TD className="tabular-nums">{m.rank}</TD>
                      <TD>
                        <span className="font-medium">{m.entityName}</span>
                        <span className="block text-xs text-muted-foreground">
                          {m.entityType === 'BRAND' ? 'Your brand' : 'Competitor'}
                        </span>
                      </TD>
                      <TD className="text-xs">
                        “{m.matchedText}”{' '}
                        <span className="text-muted-foreground">({humanize(m.matchType)})</span>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            ) : (
              <CardContent>
                <p className="text-sm text-muted-foreground">No tracked brand was mentioned.</p>
              </CardContent>
            )}
          </Card>
        </div>
      </div>
      <Card className="mt-5">
        <CardHeaderRow
          title={`Citations (${o.citations.length})`}
          description="URLs returned with the answer, in provider order"
        />
        {o.citations.length ? (
          <Table>
            <THead>
              <TR>
                <TH>#</TH>
                <TH>Source</TH>
                <TH>Type</TH>
                <TH>Attribution</TH>
              </TR>
            </THead>
            <TBody>
              {o.citations.map((c) => (
                <TR key={c.id}>
                  <TD className="tabular-nums">{c.position}</TD>
                  <TD className="max-w-[32rem]">
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex items-center gap-1 font-medium hover:text-primary"
                    >
                      {c.title ?? c.domain} <ExternalLink className="size-3 shrink-0" aria-hidden />
                    </a>
                    <span className="block truncate font-mono text-xs text-muted-foreground">{c.url}</span>
                  </TD>
                  <TD className="text-xs">{humanize(c.sourceType)}</TD>
                  <TD className="text-xs">
                    {c.isOwnedDomain ? (
                      <Badge tone="primary">Your site</Badge>
                    ) : c.competitorId ? (
                      <Badge tone="warning">{competitorName(c.competitorId) ?? 'Competitor'}</Badge>
                    ) : (
                      <span className="text-muted-foreground">Third party</span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        ) : (
          <CardContent>
            <p className="text-sm text-muted-foreground">This answer returned no citations.</p>
          </CardContent>
        )}
      </Card>
      {o.rawResponse ? (
        <Card className="mt-5">
          <details>
            <summary className="cursor-pointer p-5 text-sm font-semibold">
              Raw provider response (secrets removed, long fields truncated)
            </summary>
            <pre className="max-h-[32rem] overflow-auto border-t border-border bg-muted p-4 text-xs">
              {JSON.stringify(o.rawResponse, null, 2)}
            </pre>
          </details>
        </Card>
      ) : null}
    </>
  );
}
