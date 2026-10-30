import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeOff, RotateCcw, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import {
  AUDIT_CATEGORIES,
  AUDIT_CATEGORY_LABELS,
  ISSUE_SEVERITIES,
  type AuditCategory,
} from '@surfaced/shared';
import { SeverityBadge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { Input, NativeSelect } from '@/components/ui/form';
import { Pagination, TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate, urlPath } from '@/lib/format';
import type { IssueDto } from '@/lib/types';

export interface IssueFilters {
  severity?: string;
  category?: string;
  status?: string;
  ruleId?: string;
  q?: string;
}

/**
 * Issues with filters. `path` is either /projects/:id/issues (current issues) or
 * /audits/:id/issues (issues detected in one run).
 */
export function IssuesTable({
  path,
  projectId,
  initial = {},
  showStatusFilter = true,
}: {
  path: string;
  projectId: string;
  initial?: IssueFilters;
  showStatusFilter?: boolean;
}) {
  const [filters, setFilters] = useState<IssueFilters>(initial);
  const [search, setSearch] = useState(initial.q ?? '');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<'severity' | 'lastDetectedAt' | 'url'>('severity');
  const canUpdate = useCan('issue.update');
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['issues', projectId, path, filters, page, sort],
    queryFn: () =>
      api.page<IssueDto>(path, {
        ...filters,
        page,
        pageSize: 25,
        sort,
        order: sort === 'url' ? 'asc' : 'desc',
      }),
    placeholderData: keepPreviousData,
  });
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'OPEN' | 'IGNORED' }) =>
      api.patch<IssueDto>(`/issues/${id}`, { status }),
    onSuccess: (issue) => {
      toast.success(issue.status === 'IGNORED' ? 'Issue ignored' : 'Issue reopened');
      void queryClient.invalidateQueries({ queryKey: ['issues', projectId] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const set = (patch: IssueFilters) => {
    setPage(1);
    setFilters((f) => ({ ...f, ...patch }));
  };

  return (
    <div>
      <div className="flex flex-wrap items-end gap-2 px-5 pb-3">
        <form
          className="relative min-w-52 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: search.trim() || undefined });
          }}
        >
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search URL or issue"
            aria-label="Search issues"
            className="pl-8"
          />
        </form>
        <NativeSelect
          aria-label="Severity"
          value={filters.severity ?? ''}
          onChange={(e) => set({ severity: e.target.value || undefined })}
          className="w-36"
        >
          <option value="">All severities</option>
          {ISSUE_SEVERITIES.map((s) => (
            <option key={s} value={s}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect
          aria-label="Category"
          value={filters.category ?? ''}
          onChange={(e) => set({ category: e.target.value || undefined })}
          className="w-44"
        >
          <option value="">All categories</option>
          {AUDIT_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {AUDIT_CATEGORY_LABELS[c]}
            </option>
          ))}
        </NativeSelect>
        {showStatusFilter ? (
          <NativeSelect
            aria-label="Status"
            value={filters.status ?? 'OPEN'}
            onChange={(e) => set({ status: e.target.value })}
            className="w-36"
          >
            <option value="OPEN">Open</option>
            <option value="IGNORED">Ignored</option>
            <option value="RESOLVED">Resolved</option>
            <option value="OPEN,IGNORED,RESOLVED">All statuses</option>
          </NativeSelect>
        ) : null}
        <NativeSelect
          aria-label="Sort by"
          value={sort}
          onChange={(e) => setSort(e.target.value as typeof sort)}
          className="w-40"
        >
          <option value="severity">Most severe first</option>
          <option value="lastDetectedAt">Recently detected</option>
          <option value="url">URL</option>
        </NativeSelect>
        {filters.ruleId ? (
          <Button variant="ghost" size="sm" onClick={() => set({ ruleId: undefined })}>
            Clear rule filter
          </Button>
        ) : null}
      </div>
      {query.isPending ? (
        <LoadingBlock className="px-5 pb-5" rows={6} />
      ) : query.isError ? (
        <ErrorState className="mx-5 mb-5" error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.items.length === 0 ? (
        <EmptyState
          className="mx-5 mb-5"
          title="No issues match these filters"
          description="Try a different severity, category or status."
        />
      ) : (
        <div className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : undefined}>
          <Table>
            <THead>
              <TR>
                <TH>Issue</TH>
                <TH>Page</TH>
                <TH>Severity</TH>
                <TH>Status</TH>
                <TH>First detected</TH>
                <TH className="sr-only">Actions</TH>
              </TR>
            </THead>
            <TBody>
              {query.data.items.map((issue) => (
                <TR key={issue.id}>
                  <TD className="max-w-[22rem]">
                    <Link
                      to={`/app/p/${projectId}/issues/${issue.id}`}
                      className="font-medium hover:text-primary"
                    >
                      {issue.title}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {AUDIT_CATEGORY_LABELS[issue.category as AuditCategory] ?? issue.category}
                    </p>
                  </TD>
                  <TD className="max-w-[18rem]">
                    <span
                      className="block truncate font-mono text-xs text-muted-foreground"
                      title={issue.url ?? 'Site-wide'}
                    >
                      {issue.url ? urlPath(issue.url) : 'Site-wide'}
                    </span>
                  </TD>
                  <TD>
                    <SeverityBadge severity={issue.severity} />
                  </TD>
                  <TD>
                    <StatusBadge status={issue.status} />
                  </TD>
                  <TD className="text-xs whitespace-nowrap text-muted-foreground">
                    {formatDate(issue.firstDetectedAt)}
                  </TD>
                  <TD className="text-right">
                    {canUpdate && issue.status === 'OPEN' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => update.mutate({ id: issue.id, status: 'IGNORED' })}
                        disabled={update.isPending}
                        aria-label={`Ignore: ${issue.title}`}
                      >
                        <EyeOff /> Ignore
                      </Button>
                    ) : canUpdate && issue.status === 'IGNORED' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => update.mutate({ id: issue.id, status: 'OPEN' })}
                        disabled={update.isPending}
                        aria-label={`Reopen: ${issue.title}`}
                      >
                        <RotateCcw /> Reopen
                      </Button>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <Pagination meta={query.data.meta} onPage={setPage} />
        </div>
      )}
    </div>
  );
}
