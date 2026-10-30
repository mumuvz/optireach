import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  TREND_SCHEDULES,
  TREND_SOURCE_LABELS,
  TREND_TIME_RANGES,
  trendRegionName,
  type TrendReportSummaryDto,
  type TrendSavedQueryDto,
  type TrendSchedule,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { NativeSelect } from '@/components/ui/form';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatDateTime, formatRelative } from '@/lib/format';
import { SCHEDULE_LABELS } from './compare-form';
import { trendKeys, useSavedComparisons, useTrendHistory } from './hooks';

const period = (key: string) => TREND_TIME_RANGES.find((t) => t.key === key)?.label ?? key;
const place = (country: string | null, region: string | null, city?: string | null) => {
  const area = region ? trendRegionName(region) : (country ?? 'Worldwide');
  return city ? `${city} (mentions), ${area}` : area;
};

export function TrendHistory({
  selectedId,
  onSelect,
  onLoad,
  onStarted,
}: {
  selectedId: string | null;
  onSelect: (reportId: string) => void;
  onLoad: (saved: TrendSavedQueryDto) => void;
  onStarted: (reportId: string) => void;
}) {
  const project = useProject();
  const queryClient = useQueryClient();
  const canManage = useCan('keyword.manage');
  const history = useTrendHistory(project.id);
  const saved = useSavedComparisons(project.id);
  const refresh = () =>
    trendKeys(project.id).forEach((queryKey) => void queryClient.invalidateQueries({ queryKey }));
  const run = useMutation({
    mutationFn: (id: string) =>
      api.post<{ reportId: string }>(`/projects/${project.id}/trends/saved/${id}/run`),
    onSuccess: (r) => {
      onStarted(r.reportId);
      refresh();
    },
    onError: (e) => toast.error('Could not run the comparison', { description: errorMessage(e) }),
  });
  const update = useMutation({
    mutationFn: ({ id, schedule }: { id: string; schedule: TrendSchedule }) =>
      api.patch(`/projects/${project.id}/trends/saved/${id}`, { schedule }),
    onSuccess: () => {
      toast.success('Schedule updated');
      refresh();
    },
    onError: (e) => toast.error('Could not update', { description: errorMessage(e) }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${project.id}/trends/saved/${id}`),
    onSuccess: () => refresh(),
    onError: (e) => toast.error('Could not delete', { description: errorMessage(e) }),
  });
  const reports: TrendReportSummaryDto[] = history.data ?? [];
  const comparisons = saved.data ?? [];
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeaderRow
          title="Saved comparisons"
          description="Run them again, or refresh them weekly or monthly."
        />
        <CardContent>
          {comparisons.length ? (
            <ul className="grid gap-3">
              {comparisons.map((s) => (
                <li key={s.id} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {s.keywords.join(', ')} · {place(s.country, s.region, s.city)} · {period(s.timeRange)}
                        {s.provider ? ` · ${TREND_SOURCE_LABELS[s.provider]}` : ''}
                      </p>
                      {s.nextRunAt ? (
                        <p className="text-xs text-muted-foreground">
                          Next refresh {formatDateTime(s.nextRunAt)}
                        </p>
                      ) : null}
                    </div>
                    {canManage ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <NativeSelect
                          aria-label={`Refresh schedule for ${s.name}`}
                          value={s.schedule}
                          onChange={(e) =>
                            update.mutate({ id: s.id, schedule: e.target.value as TrendSchedule })
                          }
                          className="h-8 w-auto text-xs"
                        >
                          {TREND_SCHEDULES.map((v) => (
                            <option key={v} value={v}>
                              {SCHEDULE_LABELS[v]}
                            </option>
                          ))}
                        </NativeSelect>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onLoad(s)}
                          aria-label={`Load ${s.name} into the form`}
                        >
                          <RotateCcw />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => run.mutate(s.id)}
                          loading={run.isPending && run.variables === s.id}
                          aria-label={`Run ${s.name} now`}
                        >
                          <Play />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => remove.mutate(s.id)}
                          aria-label={`Delete ${s.name}`}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No saved comparisons yet. Use “Save comparison” above.
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeaderRow
          title="History"
          description="Every report is kept with its source and retrieval time."
        />
        <CardContent>
          {reports.length ? (
            <ul className="grid gap-1">
              {reports.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(r.id)}
                    className={cn(
                      'grid w-full gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted',
                      selectedId === r.id && 'bg-muted',
                    )}
                  >
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{r.keywords.join(', ') || 'Imported data'}</span>
                      <StatusBadge status={r.status} />
                      {r.cached ? <Badge tone="info">Reused</Badge> : null}
                      {r.partial ? <Badge tone="warning">Partial</Badge> : null}
                      {r.trigger === 'SCHEDULED' ? <Badge tone="neutral">Scheduled</Badge> : null}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {TREND_SOURCE_LABELS[r.source]} · {place(r.country, r.region, r.city)} ·{' '}
                      {period(r.timeRange)} · {formatRelative(r.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No reports yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
