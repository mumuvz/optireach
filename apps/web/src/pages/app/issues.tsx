import { useSearchParams } from 'react-router';
import { useProject } from '@/app/project-scope';
import { IssuesTable } from '@/components/app/issues-table';
import { PageHeader } from '@/components/app/page';
import { Card } from '@/components/ui/card';

export default function IssuesPage() {
  const project = useProject();
  const [params] = useSearchParams();
  const initial = {
    severity: params.get('severity') ?? undefined,
    category: params.get('category') ?? undefined,
    ruleId: params.get('ruleId') ?? undefined,
    status: params.get('status') ?? undefined,
  };
  return (
    <>
      <PageHeader
        title="Issues"
        description="Current issues across the latest crawl of each page. Issues keep their history across audits and resolve automatically when a re-crawl no longer finds them."
        breadcrumbs={[{ label: 'Website audit', to: `/app/p/${project.id}/audits` }, { label: 'Issues' }]}
      />
      <Card className="pt-4">
        {/* Remount when the URL filters change (e.g. links from the overview). */}
        <IssuesTable
          key={params.toString()}
          path={`/projects/${project.id}/issues`}
          projectId={project.id}
          initial={initial}
        />
      </Card>
    </>
  );
}
