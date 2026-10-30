import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, EyeOff, RotateCcw } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { AUDIT_CATEGORY_LABELS, type AuditCategory } from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { Evidence } from '@/components/app/evidence';
import { PageHeader } from '@/components/app/page';
import { SeverityBadge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { formatDate, formatDateTime } from '@/lib/format';
import type { IssueDto } from '@/lib/types';

interface IssueDetailDto extends IssueDto {
  history: { auditRunId: string; detectedAt: string; severity: string; crawledPageId: string | null }[];
}

export default function IssueDetailPage() {
  const project = useProject();
  const { issueId } = useParams();
  const queryClient = useQueryClient();
  const canUpdate = useCan('issue.update');
  const query = useQuery({
    queryKey: ['issue', issueId],
    queryFn: () => api.get<IssueDetailDto>(`/issues/${issueId}`),
  });
  const update = useMutation({
    mutationFn: (status: 'OPEN' | 'IGNORED') => api.patch<IssueDto>(`/issues/${issueId}`, { status }),
    onSuccess: (issue) => {
      toast.success(issue.status === 'IGNORED' ? 'Issue ignored' : 'Issue reopened');
      void queryClient.invalidateQueries({ queryKey: ['issue', issueId] });
      void queryClient.invalidateQueries({ queryKey: ['issues', project.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (query.isPending) return <LoadingBlock rows={8} />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const issue = query.data;
  const latest = issue.history[0];
  return (
    <>
      <PageHeader
        title={issue.title}
        documentTitle="Issue"
        breadcrumbs={[
          { label: 'Website audit', to: `/app/p/${project.id}/audits` },
          { label: 'Issues', to: `/app/p/${project.id}/issues` },
          { label: 'Issue' },
        ]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={issue.severity} />
            <StatusBadge status={issue.status} />
            <span>{AUDIT_CATEGORY_LABELS[issue.category as AuditCategory] ?? issue.category}</span>
            <span className="font-mono text-xs">{issue.ruleId}</span>
          </span>
        }
        actions={
          canUpdate && issue.status === 'OPEN' ? (
            <Button variant="outline" onClick={() => update.mutate('IGNORED')} loading={update.isPending}>
              <EyeOff /> Ignore
            </Button>
          ) : canUpdate && issue.status === 'IGNORED' ? (
            <Button variant="outline" onClick={() => update.mutate('OPEN')} loading={update.isPending}>
              <RotateCcw /> Reopen
            </Button>
          ) : null
        }
      />
      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-5">
          <Card>
            <CardHeaderRow title="What we found" />
            <CardContent className="space-y-4 text-sm leading-relaxed">
              {issue.url ? (
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Page:</span>
                  <a
                    href={issue.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex items-center gap-1 font-mono text-xs break-all hover:text-primary"
                  >
                    {issue.url} <ExternalLink className="size-3 shrink-0" aria-hidden />
                  </a>
                  {latest?.crawledPageId ? (
                    <Link
                      to={`/app/p/${project.id}/audits/${latest.auditRunId}/pages/${latest.crawledPageId}`}
                      className="text-[13px] font-medium text-primary hover:underline"
                    >
                      Page detail
                    </Link>
                  ) : null}
                </p>
              ) : (
                <p className="text-muted-foreground">Applies to the whole site.</p>
              )}
              <p>{issue.description}</p>
              {issue.impact ? (
                <p>
                  <span className="font-medium">Why it matters: </span>
                  {issue.impact}
                </p>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeaderRow title="How to fix it" />
            <CardContent>
              <p className="text-sm leading-relaxed">{issue.suggestedFix}</p>
              <p className="mt-3 text-xs text-muted-foreground">
                Surfaced never changes your website. Make the fix in your CMS or code, then re-run the audit
                to confirm it.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeaderRow title="Evidence" />
            <CardContent>
              <Evidence value={issue.evidence} />
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeaderRow
            title="Detection history"
            description={`First detected ${formatDate(issue.firstDetectedAt)} · last detected ${formatDate(issue.lastDetectedAt)}${issue.resolvedAt ? ` · resolved ${formatDate(issue.resolvedAt)}` : ''}`}
          />
          <CardContent>
            <ol className="space-y-2.5">
              {issue.history.map((h) => (
                <li key={h.auditRunId} className="flex items-center justify-between gap-3 text-sm">
                  <Link to={`/app/p/${project.id}/audits/${h.auditRunId}`} className="hover:text-primary">
                    {formatDateTime(h.detectedAt)}
                  </Link>
                  <SeverityBadge severity={h.severity} />
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
