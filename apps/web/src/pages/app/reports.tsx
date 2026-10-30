import { zodResolver } from '@hookform/resolvers/zod';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileBarChart, Plus } from 'lucide-react';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  REPORT_SECTIONS,
  REPORT_SECTION_LABELS,
  VISIBILITY_PROVIDERS,
  reportCreateSchema,
  type ReportCreateInput,
  type ReportSection,
} from '@surfaced/shared';
import type { z } from 'zod';
import { useProject } from '@/app/project-scope';
import { usePlanLimits, useUsage } from '@/app/queries';
import { PageHeader } from '@/components/app/page';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert, EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Checkbox, Field, Input, NativeSelect } from '@/components/ui/form';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatBytes, formatDate, formatRelative } from '@/lib/format';
import { isActiveStatus } from '@/lib/query';

export interface ReportDto {
  id: string;
  projectId: string;
  title: string;
  sections: ReportSection[];
  dateFrom: string;
  dateTo: string;
  status: string;
  pdfStatus: string | null;
  sizeBytes: number | null;
  limitations: string[];
  summary: {
    score?: number | null;
    mentionRate?: number | null;
    observations?: number;
    issues?: number | null;
    pdfNote?: string | null;
  } | null;
  whiteLabel: { enabled?: boolean; brandName?: string } | null;
  errorMessage: string | null;
  generatedAt: string | null;
  createdAt: string;
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const PRESETS = [
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 12 months', days: 365 },
];

function NewReportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const project = useProject();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const limits = usePlanLimits();
  const today = new Date();
  const form = useForm<ReportCreateInput, unknown, z.output<typeof reportCreateSchema>>({
    resolver: zodResolver(reportCreateSchema),
    defaultValues: {
      title: `${project.name} — ${today.toLocaleString('en-US', { month: 'long', year: 'numeric' })} report`,
      dateFrom: isoDay(new Date(today.getTime() - 30 * 86_400_000)),
      dateTo: isoDay(today),
      sections: ['audit_summary', 'technical_issues', 'ai_visibility', 'citation_sources', 'next_steps'],
      provider: 'all',
    },
  });
  const create = useMutation({
    mutationFn: (v: z.output<typeof reportCreateSchema>) =>
      api.post<{ jobId: string; reportId: string }>(`/projects/${project.id}/reports`, {
        ...v,
        dateFrom: isoDay(v.dateFrom),
        // Include the whole end day.
        dateTo: new Date(`${isoDay(v.dateTo)}T23:59:59.999Z`).toISOString(),
      }),
    onSuccess: (r) => {
      toast.success('Generating the report');
      void queryClient.invalidateQueries({ queryKey: ['reports', project.id] });
      onOpenChange(false);
      void navigate(`/app/p/${project.id}/reports/${r.reportId}`);
    },
    onError: (error) => {
      if (error instanceof ApiError)
        for (const [k, m] of Object.entries(error.fieldErrors))
          form.setError(k as keyof ReportCreateInput, { message: m });
    },
  });
  const e = form.formState.errors;
  const general =
    create.isError && !(create.error instanceof ApiError && Object.keys(create.error.fieldErrors).length)
      ? errorMessage(create.error)
      : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title="Generate a report"
          description="Reports are built from the data stored for this project in the chosen period. Missing data is stated in the report, never filled in."
        />
        <form onSubmit={form.handleSubmit((v) => create.mutate(v))} className="grid gap-4" noValidate>
          <Field label="Title" error={e.title?.message}>
            <Input {...form.register('title')} />
          </Field>
          <div className="flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <Button
                key={p.label}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  form.setValue('dateFrom', isoDay(new Date(Date.now() - p.days * 86_400_000)));
                  form.setValue('dateTo', isoDay(new Date()));
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="From" error={e.dateFrom?.message}>
              <Input type="date" {...form.register('dateFrom')} />
            </Field>
            <Field label="To" error={e.dateTo?.message}>
              <Input type="date" {...form.register('dateTo')} />
            </Field>
            <Field label="AI provider" description="Pooling providers is labeled in the report.">
              <NativeSelect {...form.register('provider')}>
                <option value="all">All providers</option>
                {Object.values(VISIBILITY_PROVIDERS).map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Sections</legend>
            <Controller
              control={form.control}
              name="sections"
              render={({ field }) => (
                <div className="grid gap-2 sm:grid-cols-2">
                  {REPORT_SECTIONS.map((s) => (
                    <label key={s} className="flex items-center gap-2.5 text-sm">
                      <Checkbox
                        checked={field.value.includes(s)}
                        onCheckedChange={(v) =>
                          field.onChange(v ? [...field.value, s] : field.value.filter((x) => x !== s))
                        }
                      />
                      {REPORT_SECTION_LABELS[s]}
                    </label>
                  ))}
                </div>
              )}
            />
            {e.sections ? (
              <p className="mt-1.5 text-[13px] text-destructive">
                {e.sections.message ?? e.sections.root?.message}
              </p>
            ) : null}
          </fieldset>
          {limits?.whiteLabelReports ? (
            <p className="text-xs text-muted-foreground">
              White-label settings from the workspace are applied when enabled.
            </p>
          ) : null}
          {general ? <Alert tone="danger">{general}</Alert> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Generate report
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function ReportsPage() {
  const project = useProject();
  const canCreate = useCan('report.create');
  const usage = useUsage();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const reports = useQuery({
    queryKey: ['reports', project.id, page],
    queryFn: () => api.page<ReportDto>(`/projects/${project.id}/reports`, { page, pageSize: 20 }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((r) => isActiveStatus(r.status)) ? 2500 : false),
  });
  const quota = usage.data?.metrics.find((m) => m.metric === 'REPORT');
  return (
    <>
      <PageHeader
        title="Reports"
        description={
          quota
            ? `HTML and PDF reports from stored project data. ${quota.used} of ${quota.limit ?? '∞'} reports used this month.`
            : 'HTML and PDF reports from stored project data.'
        }
        actions={
          canCreate ? (
            <Button onClick={() => setOpen(true)}>
              <Plus /> New report
            </Button>
          ) : null
        }
      />
      <Card>
        {reports.isPending ? (
          <LoadingBlock className="p-5" rows={5} />
        ) : reports.isError ? (
          <ErrorState className="m-5" error={reports.error} onRetry={() => void reports.refetch()} />
        ) : reports.data.items.length === 0 ? (
          <EmptyState
            className="m-5"
            icon={FileBarChart}
            title="No reports yet"
            description="Generate a report to share audit progress and AI visibility results for a date range."
          />
        ) : (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>Report</TH>
                  <TH>Period</TH>
                  <TH>Status</TH>
                  <TH>PDF</TH>
                  <TH>Created</TH>
                </TR>
              </THead>
              <TBody>
                {reports.data.items.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      <Link
                        to={`/app/p/${project.id}/reports/${r.id}`}
                        className="font-medium hover:text-primary"
                      >
                        {r.title}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {r.sections.length} sections
                      </span>
                    </TD>
                    <TD className="text-xs whitespace-nowrap">
                      {formatDate(r.dateFrom)} – {formatDate(r.dateTo)}
                    </TD>
                    <TD>
                      <StatusBadge status={r.status} />
                    </TD>
                    <TD className="text-xs">
                      {r.status === 'READY' ? (
                        r.pdfStatus === 'READY' ? (
                          <Badge tone="success">{formatBytes(r.sizeBytes)}</Badge>
                        ) : (
                          <Badge>{r.pdfStatus === 'FAILED' ? 'Failed' : 'Unavailable'}</Badge>
                        )
                      ) : (
                        '—'
                      )}
                    </TD>
                    <TD className="text-xs text-muted-foreground">{formatRelative(r.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <Pagination meta={reports.data.meta} onPage={setPage} />
          </>
        )}
      </Card>
      <NewReportDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
