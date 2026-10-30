import { useQueryClient } from '@tanstack/react-query';
import { TrendingUp } from 'lucide-react';
import { useState } from 'react';
import { TREND_MAX_KEYWORDS, type TrendLiveSource, type TrendSavedQueryDto } from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { ExportPdfButton } from '@/components/app/export-pdf-button';
import { JobProgress, PageHeader } from '@/components/app/page';
import { CompareForm, type CompareSettings } from '@/components/trends/compare-form';
import { trendKeys, useTrendReport, useTrendsStatus } from '@/components/trends/hooks';
import { ProviderPanel } from '@/components/trends/provider-panel';
import { TrendHistory } from '@/components/trends/trend-history';
import { TrendReportView } from '@/components/trends/trend-report';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';

export default function TrendsPage() {
  const project = useProject();
  const queryClient = useQueryClient();
  const status = useTrendsStatus(project.id);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<{ key: number; settings: CompareSettings }>({
    key: 0,
    settings: {
      terms: project.primaryKeywords.slice(0, TREND_MAX_KEYWORDS).join('\n'),
      country: project.targetCountries[0] ?? '',
      region: '',
      city: '',
      timeRange: 'past_90_days',
      category: 0,
      provider: '',
    },
  });
  const report = useTrendReport(project.id, selectedId);
  const current = report.data ?? null;
  const running = current ? ['QUEUED', 'RUNNING'].includes(current.status) : false;
  const refresh = () =>
    trendKeys(project.id).forEach((queryKey) => void queryClient.invalidateQueries({ queryKey }));
  const started = (reportId: string) => {
    setSelectedId(reportId);
    refresh();
  };
  const load = (saved: TrendSavedQueryDto) =>
    setForm((f) => ({
      key: f.key + 1,
      settings: {
        terms: saved.keywords.join('\n'),
        country: saved.country ?? '',
        region: saved.region ?? '',
        city: saved.city ?? '',
        timeRange: saved.timeRange,
        category: saved.category,
        provider: (saved.provider ?? '') as TrendLiveSource | '',
      },
    }));

  return (
    <>
      <PageHeader
        title="Keyword trends"
        description="What people search for in your field (Google Trends), which of those searches your pages do not target yet, and where to add them."
        actions={<ExportPdfButton module="trends" />}
      />
      <div className="grid gap-5">
        <CompareForm
          key={form.key}
          status={status.data}
          running={running}
          initial={form.settings}
          onStarted={started}
        />

        {running && current?.jobId ? (
          <JobProgress
            jobId={current.jobId}
            label="Fetching trends and comparing them with your site"
            onFinished={refresh}
          />
        ) : null}
        {report.isLoading ? <LoadingBlock rows={4} /> : null}
        {report.error ? <ErrorState error={report.error} onRetry={() => void report.refetch()} /> : null}
        {current?.status === 'FAILED' ? (
          <Alert tone="danger" title="This report failed">
            {current.errorMessage ?? 'Unknown error.'} Nothing was filled in: you can try again later, choose
            another data source, or import CSV files from Google Trends.
          </Alert>
        ) : null}
        {!report.isLoading && !current ? (
          <EmptyState
            icon={TrendingUp}
            title="See what people search for in your field"
            description="Choose terms that describe your products, then fetch live data or import a Google Trends CSV. The report shows rising searches, which ones your pages do not target yet, and where to add them."
          />
        ) : null}
        {current?.status === 'SUCCEEDED' ? <TrendReportView report={current} /> : null}

        <TrendHistory
          selectedId={current?.id ?? null}
          onSelect={setSelectedId}
          onLoad={load}
          onStarted={started}
        />
        {status.data ? <ProviderPanel status={status.data} /> : null}
      </div>
    </>
  );
}
