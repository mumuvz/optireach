import { FolderX } from 'lucide-react';
import { createContext, useContext, useEffect } from 'react';
import { Link, Outlet, useParams } from 'react-router';
import type { ProjectDto } from '@surfaced/shared';
import { DemoBanner } from '@/components/app/page';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { ApiError } from '@/lib/api';
import { setLastProject } from './last-project';
import { useProjectQuery } from './queries';

const ProjectContext = createContext<ProjectDto | null>(null);

/** The project of the current /app/p/:projectId route. */
export function useProject(): ProjectDto {
  const project = useContext(ProjectContext);
  if (!project) throw new Error('useProject must be used inside a project route');
  return project;
}

export function ProjectScope() {
  const { projectId } = useParams();
  const query = useProjectQuery(projectId);
  useEffect(() => {
    if (query.data) setLastProject(query.data.workspaceId, query.data.id);
  }, [query.data]);

  if (query.isPending) return <LoadingBlock rows={6} />;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return (
        <EmptyState
          icon={FolderX}
          title="Project not found"
          description="It may have been deleted, or it belongs to a workspace you are not a member of."
          action={
            <Button asChild>
              <Link to="/app/projects">View your projects</Link>
            </Button>
          }
        />
      );
    }
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }
  return (
    <ProjectContext.Provider value={query.data}>
      {query.data.isDemo ? <DemoBanner className="mb-5" /> : null}
      <Outlet />
    </ProjectContext.Provider>
  );
}
