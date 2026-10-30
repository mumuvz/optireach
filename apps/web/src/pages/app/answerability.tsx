import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircleQuestion, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useProject } from '@/app/project-scope';
import { ExportPdfButton } from '@/components/app/export-pdf-button';
import { JobProgress, MetricCard, PageHeader } from '@/components/app/page';
import { Badge, EstimateBadge, StatusBadge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { NativeSelect } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { isActiveStatus, pollWhileActive } from '@/lib/query';
import type { AnswerabilityRunDto, LlmProviderStatusDto } from '@/lib/types';

const STATUS_TONE: Record<string, BadgeTone> = { good: 'success', fair: 'warning', poor: 'danger' };
const gradeTone = (grade: string | null): 'success' | 'warning' | 'danger' | 'default' =>
  grade === 'good' ? 'success' : grade === 'fair' ? 'warning' : grade === 'poor' ? 'danger' : 'default';

export default function AnswerabilityPage() {
  const project = useProject();
  const queryClient = useQueryClient();
  const canRun = useCan('audit.run');
  const [provider, setProvider] = useState('');

  const latest = useQuery({
    queryKey: ['answerability', project.id, 'latest'],
    queryFn: () =>
      api.get<{ run: AnswerabilityRunDto | null; job: AnswerabilityRunDto['job'] }>(
        `/projects/${project.id}/answerability/latest`,
      ),
    refetchInterval: pollWhileActive<{ run: AnswerabilityRunDto | null; job: AnswerabilityRunDto['job'] }>(
      (d) => isActiveStatus(d?.job?.status) || isActiveStatus(d?.run?.status),
    ),
  });
  const providers = useQuery({
    queryKey: ['answerability', project.id, 'providers'],
    queryFn: () => api.get<LlmProviderStatusDto[]>(`/projects/${project.id}/answerability/providers`),
  });
  const configured = (providers.data ?? []).filter((p) => p.configured);
  const effectiveProvider = provider || configured.find((p) => p.isDefault)?.key || configured[0]?.key || '';

  const run = useMutation({
    mutationFn: () =>
      api.post(`/projects/${project.id}/answerability/run`, { provider: effectiveProvider || undefined }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['answerability', project.id] }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const data = latest.data;
  const r = data?.run;
  const running = isActiveStatus(data?.job?.status) || isActiveStatus(r?.status);
  const a = r?.assessment ?? null;

  return (
    <>
      <PageHeader
        title="Answerability (AEO)"
        description="How well your pages are structured to answer the questions people ask AI assistants and search engines. Assessed from page structure — titles, headings and FAQ/QA schema — not full page text, and never a measured ranking."
        actions={
          <div className="flex items-center gap-2">
            {r ? <ExportPdfButton module="answerability" /> : null}
            {canRun ? (
              <>
                {configured.length > 1 ? (
                  <NativeSelect
                    aria-label="AI provider"
                    value={effectiveProvider}
                    onChange={(e) => setProvider(e.target.value)}
                    className="h-9 w-44 text-[13px]"
                  >
                    {configured.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                        {p.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </NativeSelect>
                ) : null}
                <Button onClick={() => run.mutate()} loading={run.isPending} disabled={running}>
                  <Sparkles /> {r ? 'Re-run audit' : 'Run audit'}
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      {latest.isPending ? (
        <LoadingBlock rows={4} />
      ) : latest.isError ? (
        <ErrorState error={latest.error} onRetry={() => void latest.refetch()} />
      ) : running ? (
        <Card>
          <CardContent className="py-8">
            {data?.job?.id ? (
              <JobProgress
                jobId={data.job.id}
                label="Assessing answerability"
                onFinished={() =>
                  void queryClient.invalidateQueries({ queryKey: ['answerability', project.id] })
                }
              />
            ) : (
              <LoadingBlock rows={2} />
            )}
            <p className="mt-4 text-center text-sm text-muted-foreground">
              Reading your crawled pages’ structure and your target questions…
            </p>
          </CardContent>
        </Card>
      ) : !r ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={MessageCircleQuestion}
              title="No answerability audit yet"
              description="Run an audit to see how well your pages answer the questions people ask AI assistants. It uses your latest site crawl, so run a website audit first."
              action={
                canRun ? (
                  <Button onClick={() => run.mutate()} loading={run.isPending}>
                    <Sparkles /> Run audit
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : r.status === 'FAILED' ? (
        <Alert tone="danger">
          The answerability audit failed{r.errorMessage ? `: ${r.errorMessage}` : '.'} You can try running it
          again.
        </Alert>
      ) : (
        <div className="grid gap-5">
          <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <EstimateBadge label={r.isDevAdapter ? 'Development template' : 'AI assessment'} />
            {r.isDevAdapter
              ? 'Template assessment computed from page structure — not AI-generated.'
              : `Assessed by ${r.provider ?? 'an AI model'}${r.model ? ` (${r.model})` : ''} from page structure — an interpretive guide, not a measured ranking.`}
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            <MetricCard
              label="Answerability index"
              value={r.score ?? '—'}
              tone={gradeTone(r.grade)}
              sub={r.grade ? r.grade[0]!.toUpperCase() + r.grade.slice(1) : undefined}
              help="A qualitative 0–100 judgement of how well your pages are structured to answer questions. It is not a search-engine score and no ranking is implied."
            />
            <MetricCard label="Pages considered" value={r.pagesConsidered} sub="From your latest crawl" />
            <MetricCard
              label="Questions considered"
              value={r.questionsConsidered}
              sub="Your AI prompts / keywords"
            />
          </div>

          {a?.summary ? (
            <Card>
              <CardContent className="text-sm leading-relaxed">{a.summary}</CardContent>
            </Card>
          ) : null}

          {a && (a.strengths.length || a.gaps.length) ? (
            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeaderRow title="Strengths" />
                <CardContent>
                  {a.strengths.length ? (
                    <ul className="grid list-disc gap-1.5 pl-5 text-sm">
                      {a.strengths.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">None identified.</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeaderRow title="Gaps" />
                <CardContent>
                  {a.gaps.length ? (
                    <ul className="grid list-disc gap-1.5 pl-5 text-sm">
                      {a.gaps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">None identified.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}

          {a?.findings.length ? (
            <Card>
              <CardHeaderRow title="Findings and recommendations" />
              <CardContent className="grid gap-3">
                {a.findings.map((f, i) => (
                  <div key={i} className="rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium">{f.area}</p>
                      <Badge tone={STATUS_TONE[f.status] ?? 'neutral'}>
                        {f.status[0]!.toUpperCase() + f.status.slice(1)}
                      </Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{f.detail}</p>
                    <p className="mt-2 text-sm">
                      <span className="font-medium">Fix: </span>
                      {f.recommendation}
                    </p>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {a?.questionCoverage.length ? (
            <Card>
              <CardHeaderRow title="Question coverage" />
              <CardContent className="grid gap-2">
                {a.questionCoverage.map((q, i) => (
                  <div key={i} className="flex items-start gap-3 text-sm">
                    <Badge tone={q.covered ? 'success' : 'warning'} className="mt-0.5 shrink-0">
                      {q.covered ? 'Covered' : 'Gap'}
                    </Badge>
                    <div>
                      <p className="font-medium">{q.question}</p>
                      <p className="text-muted-foreground">{q.note}</p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {r.limitations.length ? (
            <Card>
              <CardHeaderRow title="Limitations" />
              <CardContent>
                <ul className="grid list-disc gap-1.5 pl-5 text-sm text-muted-foreground">
                  {r.limitations.map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}

          {run.isError ? <Alert tone="danger">{errorMessage(run.error)}</Alert> : null}
          <p className="text-xs text-muted-foreground">
            Last run {new Date(r.createdAt).toLocaleString()} · <StatusBadge status={r.status} />
          </p>
        </div>
      )}
    </>
  );
}
