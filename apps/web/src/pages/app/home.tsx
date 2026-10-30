import { Navigate } from 'react-router';
import { getLastProject } from '@/app/last-project';
import { useProjects, useWorkspaceId } from '@/app/queries';
import { ErrorState, LoadingBlock } from '@/components/ui/feedback';

/** /app: open the last used project, or start onboarding when there is none. */
export default function AppHome() {
  const projects = useProjects();
  const workspaceId = useWorkspaceId();
  if (projects.isPending) return <LoadingBlock rows={6} />;
  if (projects.isError) return <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />;
  const list = projects.data;
  if (!list.length) return <Navigate to="/app/projects/new?welcome=1" replace />;
  const last = getLastProject(workspaceId);
  const target = list.find((p) => p.id === last) ?? list[0]!;
  return <Navigate to={`/app/p/${target.id}`} replace />;
}
