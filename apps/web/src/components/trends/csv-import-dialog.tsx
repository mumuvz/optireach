import { useMutation } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  TREND_CSV_KIND_LABELS,
  TREND_IMPORT_MAX_FILES,
  TREND_TIME_RANGES,
  buildTrendsImport,
  countryName,
  trendRegionName,
  type TrendTimeRange,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { Input, NativeSelect } from '@/components/ui/form';
import { TBody, TD, TH, THead, TR, Table } from '@/components/ui/table';
import { api, errorMessage } from '@/lib/api';

interface LoadedFile {
  name: string;
  content: string;
  keyword?: string;
}

/**
 * Import of the CSV files Google Trends exports. Files are read in the browser first and shown with what was found
 * (kind, terms, rows, first values) so the user can check them before anything is saved.
 */
export function CsvImportDialog({
  open,
  onOpenChange,
  settings,
  knownTerms,
  suggestPlacements,
  onImported,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  settings: { country: string | null; region: string | null; timeRange: TrendTimeRange; category: number };
  knownTerms: string[];
  suggestPlacements: boolean;
  onImported: (reportId: string) => void;
}) {
  const project = useProject();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const preview = useMemo(
    () => (files.length ? buildTrendsImport(files, { keywords: undefined }) : null),
    [files],
  );
  const termChoices = preview?.keywords.length ? preview.keywords : knownTerms;

  const reset = () => {
    setFiles([]);
    setReadError(null);
  };
  const importFiles = useMutation({
    mutationFn: () =>
      api.post<{ reportId: string }>(`/projects/${project.id}/trends/import`, {
        ...settings,
        keywords: preview?.keywords.length ? undefined : knownTerms.length ? knownTerms : undefined,
        suggestPlacements,
        files,
      }),
    onSuccess: (r) => {
      toast.success('Imported. Comparing with your site…');
      onImported(r.reportId);
      reset();
      onOpenChange(false);
    },
    onError: (e) => toast.error('Could not import the files', { description: errorMessage(e) }),
  });

  const place = settings.region
    ? `${trendRegionName(settings.region)}, ${countryName(settings.region.slice(0, 2))}`
    : settings.country
      ? countryName(settings.country)
      : 'Worldwide';
  const period = TREND_TIME_RANGES.find((t) => t.key === settings.timeRange)?.label ?? settings.timeRange;
  const readable = preview?.files.filter((f) => !f.error).length ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent size="xl">
        <DialogHeader
          title="Import from Google Trends"
          description="In Google Trends, use the download icon on “Interest over time”, “Interest by subregion”, “Related topics” and “Related queries”, then add the files here unchanged."
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => input.current?.click()}>
            <FileUp /> Choose CSV files
          </Button>
          <input
            ref={input}
            type="file"
            accept=".csv,text/csv"
            multiple
            hidden
            aria-label="CSV files exported from Google Trends"
            onChange={async (e) => {
              const chosen = [...(e.target.files ?? [])].slice(0, TREND_IMPORT_MAX_FILES);
              e.target.value = '';
              try {
                const loaded = await Promise.all(
                  chosen.map(async (f) => ({ name: f.name, content: await f.text() })),
                );
                setFiles((prev) => [...prev, ...loaded].slice(0, TREND_IMPORT_MAX_FILES));
                setReadError(null);
              } catch (error) {
                setReadError(errorMessage(error));
              }
            }}
          />
          <span className="text-[13px] text-muted-foreground">
            Saved as {place} · {period}
            {settings.category ? ` · category ${settings.category}` : ''} (from the comparison form). Up to{' '}
            {TREND_IMPORT_MAX_FILES} files.
          </span>
        </div>
        {readError ? (
          <Alert tone="danger" title="A file could not be read">
            {readError}
          </Alert>
        ) : null}
        {preview ? (
          <>
            <Table>
              <THead>
                <TR>
                  <TH>File</TH>
                  <TH>Contains</TH>
                  <TH>Terms</TH>
                  <TH className="text-right">Rows</TH>
                  <TH>First rows</TH>
                </TR>
              </THead>
              <TBody>
                {preview.files.map((f, i) => (
                  <TR key={`${f.name}-${i}`}>
                    <TD className="align-top">
                      <div className="font-medium break-all">{f.name}</div>
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:underline"
                        onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                      >
                        Remove
                      </button>
                    </TD>
                    <TD className="align-top">
                      {f.error ? (
                        <Badge tone="danger">Not recognised</Badge>
                      ) : (
                        <Badge tone="success">{f.kind ? TREND_CSV_KIND_LABELS[f.kind] : '—'}</Badge>
                      )}
                      {f.headerNote ? (
                        <div className="mt-1 text-xs text-muted-foreground">{f.headerNote}</div>
                      ) : null}
                    </TD>
                    <TD className="align-top text-sm">
                      {f.kind === 'related_queries' || f.kind === 'related_topics' ? (
                        termChoices.length ? (
                          <NativeSelect
                            aria-label={`Term for ${f.name}`}
                            value={files[i]?.keyword ?? f.keywords[0] ?? ''}
                            onChange={
                              (e) =>
                              setFiles((prev) => prev.map((p, j) => (j === i ? { ...p, keyword: e.target.value || undefined } : p))) // prettier-ignore
                            }
                          >
                            <option value="">Which term is this for?</option>
                            {termChoices.map((t) => (
                              <option key={t} value={t}>
                                {t}
                              </option>
                            ))}
                          </NativeSelect>
                        ) : (
                          <Input
                            aria-label={`Term for ${f.name}`}
                            placeholder="Term this file is for"
                            value={files[i]?.keyword ?? ''}
                            onChange={
                              (e) =>
                              setFiles((prev) => prev.map((p, j) => (j === i ? { ...p, keyword: e.target.value || undefined } : p))) // prettier-ignore
                            }
                          />
                        )
                      ) : (
                        f.keywords.join(', ') || '—'
                      )}
                    </TD>
                    <TD className="text-right align-top tabular-nums">{f.rows || '—'}</TD>
                    <TD className="align-top text-xs text-muted-foreground">
                      {f.error ??
                        f.sample.slice(0, 3).map((row, r) => (
                          <div key={r} className="truncate">
                            {row.join(' · ')}
                          </div>
                        ))}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            {preview.warnings.length ? (
              <ul className="list-disc space-y-1 pl-5 text-[13px] text-amber-800 dark:text-amber-300">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No files yet.</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => importFiles.mutate()}
            loading={importFiles.isPending}
            disabled={!preview?.ok}
          >
            Import {readable ? `${readable} file${readable === 1 ? '' : 's'}` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
