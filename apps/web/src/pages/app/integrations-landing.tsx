import { Navigate, Link, useSearchParams } from 'react-router';
import { useActiveProjectId } from '@/app/shell';
import { PageHeader } from '@/components/app/page';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';

/** /app/integrations: OAuth errors land here when the project is unknown; otherwise forward to the project's page. */
export default function IntegrationsLanding() {
  const [params] = useSearchParams();
  const projectId = useActiveProjectId();
  const error = params.get('integrationError');
  if (!error && projectId) return <Navigate to={`/app/p/${projectId}/integrations`} replace />;
  return (
    <>
      <PageHeader title="Integrations" />
      <Alert
        tone={error ? 'danger' : 'info'}
        title={error ? 'The connection was not completed' : 'Choose a project'}
      >
        {error ?? 'Integrations are connected per project.'}
      </Alert>
      <div className="mt-5 flex gap-2">
        {projectId ? (
          <Button asChild>
            <Link to={`/app/p/${projectId}/integrations`}>Back to integrations</Link>
          </Button>
        ) : null}
        <Button asChild variant="outline">
          <Link to="/app/projects">Projects</Link>
        </Button>
      </div>
    </>
  );
}
