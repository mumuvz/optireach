import { FolderPlus, Globe, Plus } from 'lucide-react';
import { Link } from 'react-router';
import { useProjects, useUsage } from '@/app/queries';
import { PageHeader } from '@/components/app/page';
import { ScoreRing } from '@/components/app/score-ring';
import { DemoBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { industryLabel } from '@surfaced/shared';
import { useCan } from '@/lib/auth';
import { formatDate, formatRelative } from '@/lib/format';

export default function ProjectsPage() {
  const projects = useProjects();
  const usage = useUsage();
  const canCreate = useCan('project.create');
  const projectLimit = usage.data?.counts.find((c) => c.kind === 'projects');
  const atLimit = projectLimit ? projectLimit.used >= projectLimit.limit : false;
  return (
    <>
      <PageHeader
        title="Projects"
        description={
          projectLimit
            ? `${projectLimit.used} of ${projectLimit.limit} projects on the ${usage.data?.plan.name} plan.`
            : 'Each project is one website with its own audits, prompts, content and reports.'
        }
        actions={
          !canCreate ? null : atLimit ? (
            <Button asChild variant="outline">
              <Link to="/app/billing">Upgrade for more projects</Link>
            </Button>
          ) : (
            <Button asChild>
              <Link to="/app/projects/new">
                <Plus /> New project
              </Link>
            </Button>
          )
        }
      />
      {projects.isPending ? (
        <LoadingBlock rows={6} />
      ) : projects.isError ? (
        <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
      ) : projects.data.length === 0 ? (
        <EmptyState
          icon={FolderPlus}
          title="No projects yet"
          description={
            canCreate
              ? 'Add your website to run the first audit and start tracking AI visibility.'
              : 'Ask a workspace owner or admin to create a project.'
          }
          action={
            !canCreate ? undefined : (
              <Button asChild>
                <Link to="/app/projects/new">Create your first project</Link>
              </Button>
            )
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.data.map((p) => (
            <Card key={p.id} className="flex flex-col p-5 transition-colors hover:border-primary/40">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="truncate text-[15px] font-semibold">
                    <Link to={`/app/p/${p.id}`} className="hover:text-primary">
                      {p.name}
                    </Link>
                  </h2>
                  <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                    <Globe className="size-3.5 shrink-0" aria-hidden /> {p.domain ?? 'No website'}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {p.isDemo ? <DemoBadge /> : null}
                    {p.industry ? (
                      <span className="text-xs text-muted-foreground">{industryLabel(p.industry)}</span>
                    ) : null}
                  </div>
                </div>
                <ScoreRing score={p.latestScore} size={64} label="Health" />
              </div>
              <p className="mt-4 text-xs text-muted-foreground">
                {p.latestAuditAt ? `Last audit ${formatRelative(p.latestAuditAt)}` : 'No audit yet'} · created{' '}
                {formatDate(p.createdAt)}
              </p>
              <div className="mt-4 flex gap-2">
                <Button asChild size="sm">
                  <Link to={`/app/p/${p.id}`}>Open</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link to={`/app/p/${p.id}/audits`}>Audits</Link>
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
