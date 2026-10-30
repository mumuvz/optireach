import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { PageHeader } from '@/components/app/page';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/feedback';

export default function AppNotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState
        icon={Compass}
        title="This page does not exist"
        description="The link may be outdated, or the item may have been deleted."
        action={
          <Button asChild>
            <Link to="/app">Go to the dashboard</Link>
          </Button>
        }
      />
    </>
  );
}
