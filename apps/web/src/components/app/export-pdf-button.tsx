import { FileDown } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useProject } from '@/app/project-scope';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';

/** Downloads the current project module as a PDF (audit, visibility, keywords, …). */
export function ExportPdfButton({
  module,
  label = 'Export PDF',
}: {
  module:
    | 'audit'
    | 'visibility'
    | 'competitors'
    | 'keywords'
    | 'recommendations'
    | 'content'
    | 'answerability'
    | 'trends';
  label?: string;
}) {
  const project = useProject();
  const [loading, setLoading] = useState(false);
  const onClick = async () => {
    setLoading(true);
    try {
      await api.download(`/projects/${project.id}/export/${module}`, undefined, `${module}.pdf`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Button variant="outline" onClick={onClick} loading={loading}>
      <FileDown /> {label}
    </Button>
  );
}
