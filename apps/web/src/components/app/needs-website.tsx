import { Globe } from 'lucide-react';
import { Link } from 'react-router';
import { useProject } from '@/app/project-scope';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/feedback';

/**
 * Shown on website-only pages (audits, SEO comparison, competitor gaps) when the business has no website: a clear
 * state with a link to add one, instead of a button that can only fail. The backend refuses these features without a
 * website; this keeps the UI honest about why.
 */
export function NeedsWebsite({ feature, description }: { feature: string; description: string }) {
  const project = useProject();
  return (
    <EmptyState
      icon={Globe}
      title={`${feature} needs a website`}
      description={`${description} This business has no website yet. Add one in project settings — everything else (local rankings, Business Profile, AI visibility and products) works without one.`}
      action={
        <Button asChild>
          <Link to={`/app/p/${project.id}/settings#website`}>Add a website</Link>
        </Button>
      }
    />
  );
}
