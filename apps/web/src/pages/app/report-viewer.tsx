import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import type { JobDto } from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { PageHeader } from '@/components/app/page';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Alert, ErrorState, LoadingBlock, Progress } from '@/components/ui/feedback';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate, formatDateTime } from '@/lib/format';
import { isActiveStatus } from '@/lib/query';
import type { ReportDto } from './reports';

export default function ReportViewerPage() {
  const project = useProject();
  const { reportId } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canDelete = useCan('report.delete');
  const report = useQuery({
    queryKey: ['report', reportId],
    queryFn: () => api.get<ReportDto & { job: JobDto | null }>(`/reports/${reportId}`),
    refetchInterval: (q) => (q.state.data && isActiveStatus(q.state.data.status) ? 2000 : false),
  });
  if (report.isPending) return <LoadingBlock rows={6} />;
  if (report.isError) return <ErrorState error={report.error} onRetry={() => void report.refetch()} />;
  const r = report.data;
  const ready = r.status === 'READY';
  return (
    <>
      <PageHeader
        title={r.title}
        documentTitle="Report"
        breadcrumbs={[{ label: 'Reports', to: `/app/p/${project.id}/reports` }, { label: 'Report' }]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={r.status} />
            {formatDate(r.dateFrom)} – {formatDate(r.dateTo)}
            {r.generatedAt ? <span>· generated {formatDateTime(r.generatedAt)}</span> : null}
          </span>
        }
        actions={
          <>
            {ready ? (
              <Button
                variant="outline"
                onClick={() =>
                  api
                    .download(`/reports/${r.id}/html`, { download: '1' }, 'report.html')
                    .catch((e: unknown) => toast.error(errorMessage(e)))
                }
              >
                <Download /> HTML
              </Button>
            ) : null}
            {ready && r.pdfStatus === 'READY' ? (
              <Button
                onClick={() =>
                  api
                    .download(`/reports/${r.id}/pdf`, undefined, 'report.pdf')
                    .catch((e: unknown) => toast.error(errorMessage(e)))
                }
              >
                <Download /> PDF
              </Button>
            ) : null}
            {canDelete ? (
              <ConfirmDialog
                title="Delete this report?"
                description="The HTML and PDF files are deleted. The project data it was built from is not affected."
                confirmLabel="Delete report"
                destructive
                onConfirm={async () => {
                  await api.delete(`/reports/${r.id}`);
                  await queryClient.invalidateQueries({ queryKey: ['reports', project.id] });
                  toast.success('Report deleted');
                  void navigate(`/app/p/${project.id}/reports`);
                }}
                trigger={
                  <Button variant="ghost" size="icon" aria-label="Delete report">
                    <Trash2 />
                  </Button>
                }
              />
            ) : null}
          </>
        }
      />
      {isActiveStatus(r.status) ? (
        <Card className="p-5" aria-live="polite">
          <p className="font-medium">Generating the report…</p>
          <Progress className="mt-3" value={Math.max(5, r.job?.progress ?? 5)} label="Report progress" />
          <p className="mt-2 text-sm text-muted-foreground">{r.job?.message ?? 'Waiting for a worker'}</p>
        </Card>
      ) : r.status === 'FAILED' ? (
        <Alert tone="danger" title="The report could not be generated">
          {r.errorMessage ?? r.job?.error ?? 'Unknown error.'}
        </Alert>
      ) : (
        <>
          {r.pdfStatus && r.pdfStatus !== 'READY' ? (
            <Alert
              tone="info"
              className="mb-4"
              title={
                r.pdfStatus === 'FAILED'
                  ? 'The PDF could not be rendered'
                  : 'PDF rendering is not available on this server'
              }
            >
              {r.summary?.pdfNote ?? 'The HTML version is complete and can be printed from the browser.'}
            </Alert>
          ) : null}
          {r.limitations.length ? (
            <Alert tone="warning" className="mb-4" title="Data gaps in this period">
              <ul className="list-disc space-y-0.5 pl-4">
                {r.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
          <Card className="overflow-hidden">
            {/* Static HTML served with its own sandboxing Content-Security-Policy; scripts never run. */}
            <iframe
              title={r.title}
              src={api.url(`/reports/${r.id}/html`)}
              sandbox=""
              className="h-[80vh] w-full bg-white"
            />
          </Card>
        </>
      )}
    </>
  );
}
