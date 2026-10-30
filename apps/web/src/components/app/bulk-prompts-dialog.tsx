import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  KEYWORD_QUESTION_TEMPLATES,
  PROMPT_BULK_MAX,
  PROMPT_FREQUENCIES,
  countryName,
  countryOptions,
  expandKeywords,
  isFrequencyAllowed,
  languageOptions,
  normalizePromptText,
} from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { usePlanLimits } from '@/app/queries';
import { useJob } from '@/components/app/page';
import { useProviderStatuses } from '@/components/app/visibility-filters';
import { Badge, humanize } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { Checkbox, Field, Input, NativeSelect, Textarea } from '@/components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';
import type { PromptDto } from '@/lib/types';

type SkipReason = 'too_short' | 'duplicate' | 'already_tracked';
const SKIP_LABELS: Record<SkipReason, string> = {
  too_short: 'too short to be a full question',
  duplicate: 'repeated in the list',
  already_tracked: 'already tracked',
};

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean);

/** Adds many tracked prompts at once: pasted questions, or keywords turned into questions with templates. */
export function BulkPromptsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const project = useProject();
  const queryClient = useQueryClient();
  const providers = useProviderStatuses();
  const limits = usePlanLimits();
  const countries = useMemo(() => countryOptions(), []);
  const languages = useMemo(() => languageOptions(), []);
  const configured = (providers.data?.providers ?? []).filter((p) => p.configured);
  const [mode, setMode] = useState<'questions' | 'keywords'>('keywords');
  const [questions, setQuestions] = useState('');
  const [keywords, setKeywords] = useState('');
  const [templates, setTemplates] = useState<string[]>(['best', 'best-in']);
  const [country, setCountry] = useState(project.targetCountries[0] ?? 'US');
  const [language, setLanguage] = useState(project.targetLanguages[0] ?? 'en');
  const [frequency, setFrequency] = useState<(typeof PROMPT_FREQUENCIES)[number]>('WEEKLY');
  const [chosenProviders, setChosenProviders] = useState<string[] | null>(null);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [skipped, setSkipped] = useState<{ text: string; reason: SkipReason }[]>([]);
  const providerKeys =
    chosenProviders ??
    (configured.length ? [configured.find((p) => p.key !== 'mock_demo')?.key ?? configured[0]!.key] : []);

  const candidates =
    mode === 'questions'
      ? lines(questions)
      : expandKeywords(
          lines(keywords),
          KEYWORD_QUESTION_TEMPLATES.filter((t) => templates.includes(t.key)).map((t) => t.template),
          { country: countryName(country) },
        );
  const preview = candidates.filter((t) => !removed.has(normalizePromptText(t)));
  const tooMany = preview.length > PROMPT_BULK_MAX;

  const save = useMutation({
    mutationFn: () =>
      api.post<{ created: PromptDto[]; skipped: { text: string; reason: SkipReason }[] }>(
        `/projects/${project.id}/prompts/bulk`,
        {
          texts: preview,
          country,
          language,
          providers: providerKeys,
          frequency,
          competitorIds: project.competitors.map((c) => c.id),
          status: 'ACTIVE',
        },
      ),
    onSuccess: (r) => {
      void queryClient.invalidateQueries({ queryKey: ['prompts', project.id] });
      toast.success(`Added ${r.created.length} prompt${r.created.length === 1 ? '' : 's'}`, {
        description: r.skipped.length ? `${r.skipped.length} skipped` : 'Run AI checks to see the answers.',
      });
      setSkipped(r.skipped);
      if (!r.skipped.length) {
        setQuestions('');
        setKeywords('');
        setRemoved(new Set());
        onOpenChange(false);
      }
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSkipped([]);
        onOpenChange(next);
      }}
    >
      <DialogContent size="lg">
        <DialogHeader
          title="Add prompts in bulk"
          description="Paste the questions customers ask AI assistants, or turn your keywords into such questions. Every prompt gets the settings below; you can edit or pause any of them later."
        />
        <div className="grid gap-4">
          <Tabs value={mode} onValueChange={(v) => setMode(v as 'questions' | 'keywords')}>
            <TabsList>
              <TabsTrigger value="keywords">Keywords → questions</TabsTrigger>
              <TabsTrigger value="questions">Questions</TabsTrigger>
            </TabsList>
            <TabsContent value="keywords" className="grid gap-3 pt-3">
              <AiKeywordGenerator
                country={country}
                language={language}
                onIdeas={(phrases, related) => {
                  setKeywords((prev) => [...new Set([...lines(prev), ...phrases])].join('\n'));
                  setQuestions((prev) => [...new Set([...lines(prev), ...related])].join('\n'));
                }}
              />
              <Field
                label="Keywords"
                description="One per line, for example “digital wedding invitation maker”."
              >
                <Textarea rows={5} value={keywords} onChange={(e) => setKeywords(e.target.value)} />
              </Field>
              {project.primaryKeywords.length ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="justify-self-start"
                  onClick={() =>
                    setKeywords((prev) =>
                      [...new Set([...lines(prev), ...project.primaryKeywords])].join('\n'),
                    )
                  }
                >
                  Use my primary keywords ({project.primaryKeywords.length})
                </Button>
              ) : null}
              <fieldset>
                <legend className="mb-2 text-sm font-medium">Questions to make from each keyword</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {KEYWORD_QUESTION_TEMPLATES.map((t) => (
                    <label key={t.key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={templates.includes(t.key)}
                        onCheckedChange={(v) =>
                          setTemplates((prev) =>
                            v === true ? [...prev, t.key] : prev.filter((k) => k !== t.key),
                          )
                        }
                      />
                      {t.template.replace('{country}', countryName(country))}
                    </label>
                  ))}
                </div>
              </fieldset>
            </TabsContent>
            <TabsContent value="questions" className="pt-3">
              <Field label="Questions" description="One per line. Bullets and numbering are removed.">
                <Textarea
                  rows={8}
                  value={questions}
                  onChange={(e) => setQuestions(e.target.value)}
                  placeholder={
                    'Best app to make digital wedding invitations in India\nWebsite for haldi and mehendi invitation cards'
                  }
                />
              </Field>
            </TabsContent>
          </Tabs>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Country">
              <NativeSelect value={country} onChange={(e) => setCountry(e.target.value)}>
                {countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Language">
              <NativeSelect value={language} onChange={(e) => setLanguage(e.target.value)}>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Frequency">
              <NativeSelect
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as (typeof PROMPT_FREQUENCIES)[number])}
              >
                {PROMPT_FREQUENCIES.map((f) => (
                  <option key={f} value={f} disabled={limits ? !isFrequencyAllowed(limits, f) : false}>
                    {f === 'MANUAL' ? 'Manual only' : humanize(f)}
                    {limits && !isFrequencyAllowed(limits, f) ? ' (upgrade)' : ''}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Providers</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {configured.map((p) => (
                <label key={p.key} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={providerKeys.includes(p.key)}
                    onCheckedChange={(v) =>
                      setChosenProviders(
                        v === true ? [...providerKeys, p.key] : providerKeys.filter((k) => k !== p.key),
                      )
                    }
                  />
                  {p.label}
                  {p.status === 'demo' ? <Badge tone="demo">Demo data</Badge> : null}
                </label>
              ))}
              {!configured.length ? (
                <span className="text-sm text-muted-foreground">
                  No AI provider is configured on this server.
                </span>
              ) : null}
            </div>
          </fieldset>

          <div>
            <p className="mb-2 text-sm font-medium">
              Preview: {preview.length} prompt{preview.length === 1 ? '' : 's'}
              {tooMany ? ` (at most ${PROMPT_BULK_MAX} at a time)` : ''}
            </p>
            {preview.length ? (
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2 text-sm">
                {preview.map((text) => (
                  <li key={normalizePromptText(text)} className="flex items-start justify-between gap-2">
                    <span className={text.length < 10 ? 'text-muted-foreground line-through' : ''}>
                      {text}
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => setRemoved((prev) => new Set(prev).add(normalizePromptText(text)))}
                      aria-label={`Remove ${text}`}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing to add yet.</p>
            )}
          </div>
          {skipped.length ? (
            <Alert tone="info" title={`${skipped.length} not added`}>
              <ul className="list-disc pl-5">
                {skipped.slice(0, 20).map((s) => (
                  <li key={`${s.reason}:${s.text}`}>
                    “{s.text}”: {SKIP_LABELS[s.reason]}
                  </li>
                ))}
              </ul>
            </Alert>
          ) : null}
          {save.isError ? <Alert tone="danger">{errorMessage(save.error)}</Alert> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {skipped.length ? 'Close' : 'Cancel'}
          </Button>
          <Button
            type="button"
            loading={save.isPending}
            disabled={!preview.length || tooMany || !providerKeys.length}
            onClick={() => save.mutate()}
          >
            Add {preview.length || ''} prompt{preview.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface KeywordIdeasResult {
  suggestions: { phrase: string; relatedQuestions: string[] }[];
  isDevAdapter: boolean;
  label: string;
}

/** Asks the AI provider for keyword ideas about the business (its pages, products and keywords). */
function AiKeywordGenerator({
  country,
  language,
  onIdeas,
}: {
  country: string;
  language: string;
  onIdeas: (phrases: string[], relatedQuestions: string[]) => void;
}) {
  const project = useProject();
  const canSuggest = useCan('keyword.manage');
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState(20);
  const [jobId, setJobId] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () =>
      api.post<{ jobId: string }>(`/projects/${project.id}/keywords/suggest`, {
        seed: topic.trim() || undefined,
        country,
        language,
        count,
      }),
    onSuccess: (r) => setJobId(r.jobId),
    onError: (e) => toast.error('Could not generate keywords', { description: errorMessage(e) }),
  });
  const job = useJob(jobId, (finished) => {
    setJobId(null);
    if (finished.status !== 'SUCCEEDED') {
      toast.error('Keyword generation failed', { description: finished.error ?? undefined });
      return;
    }
    const result = finished.result as KeywordIdeasResult | null;
    const ideas = result?.suggestions ?? [];
    onIdeas(
      ideas.map((s) => s.phrase),
      ideas.flatMap((s) => s.relatedQuestions),
    );
    toast.success(`Added ${ideas.length} keyword ideas`, {
      description: result?.isDevAdapter
        ? 'Template ideas from the development adapter, not AI-generated.'
        : 'AI ideas without measured search volume; the related questions are in the Questions tab.',
    });
  });
  if (!canSuggest) return null;
  const busy = start.isPending || Boolean(jobId);
  return (
    <div className="grid gap-3 rounded-lg border border-dashed p-3">
      <p className="text-sm font-medium">Generate keywords with AI</p>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
        <Field label="Topic" optional description="Leave empty for ideas about your whole business.">
          <Input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="e.g. haldi invitations"
          />
        </Field>
        <Field label="How many">
          <NativeSelect value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[10, 20, 30, 50].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Button type="button" variant="outline" loading={busy} onClick={() => start.mutate()}>
          <Sparkles /> Generate
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {busy && job.data?.message
          ? job.data.message
          : 'Uses your OpenAI key and one AI keyword run from this month’s quota. Ideas are based on your pages, products and keywords; review them before adding.'}
      </p>
    </div>
  );
}
