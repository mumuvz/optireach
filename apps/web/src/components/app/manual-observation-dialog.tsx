import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { AI_SURFACES, AI_SURFACE_LABELS, type AiSurface } from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Alert } from '@/components/ui/feedback';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/form';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { PromptDto } from '@/lib/types';

/** Local date-time for the input's default ("now" in the user's time zone). */
function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * Records what a person saw in an AI system without an API (Google AI Mode, AI Overviews, the ChatGPT or Gemini apps).
 * The observation is labeled manual everywhere and never shown as an automatic measurement.
 */
export function ManualObservationDialog({
  open,
  onOpenChange,
  prompts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompts: PromptDto[];
}) {
  const project = useProject();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [promptId, setPromptId] = useState(prompts[0]?.id ?? '');
  const [surface, setSurface] = useState<AiSurface>('GOOGLE_AI_MODE');
  const [answerText, setAnswerText] = useState('');
  const [links, setLinks] = useState('');
  const [observedAt, setObservedAt] = useState(localNow);
  const [city, setCity] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const prompt = prompts.find((p) => p.id === promptId);
  const save = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>(`/projects/${project.id}/ai-visibility/observations/manual`, {
        promptId,
        surface,
        answerText,
        citedUrls: links
          .split(/\s+/)
          .map((l) => l.trim())
          .filter((l) => /^https?:\/\//i.test(l)),
        observedAt: new Date(observedAt).toISOString(),
        city: (city ?? prompt?.city ?? '').trim() || null,
        note: note.trim() || undefined,
      }),
    onSuccess: (o) => {
      toast.success('Observation recorded', { description: 'It is labeled as a manual observation.' });
      void queryClient.invalidateQueries({ queryKey: ['visibility', project.id] });
      onOpenChange(false);
      void navigate(`/app/p/${project.id}/visibility/observations/${o.id}`);
    },
  });
  const fieldError = (name: string) =>
    save.error instanceof ApiError ? save.error.fieldErrors[name] : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader
          title="Record what an AI system showed"
          description="For AI systems without an API for tracking, such as Google AI Mode and AI Overviews. Ask the prompt yourself, then paste the answer and its source links. It is stored as a manual observation with the time and place you give."
        />
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Prompt" error={fieldError('promptId')}>
              <NativeSelect value={promptId} onChange={(e) => setPromptId(e.target.value)}>
                {prompts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.text.slice(0, 90)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Where you saw it">
              <NativeSelect value={surface} onChange={(e) => setSurface(e.target.value as AiSurface)}>
                {AI_SURFACES.map((s) => (
                  <option key={s} value={s}>
                    {AI_SURFACE_LABELS[s]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field
            label="The answer"
            description="Copy the whole answer as shown."
            error={fieldError('answerText')}
          >
            <Textarea rows={8} value={answerText} onChange={(e) => setAnswerText(e.target.value)} />
          </Field>
          <Field
            label="Source links"
            optional
            description="The links the answer showed as sources, one per line."
            error={fieldError('citedUrls')}
          >
            <Textarea
              rows={3}
              value={links}
              onChange={(e) => setLinks(e.target.value)}
              placeholder="https://…"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="When" error={fieldError('observedAt')}>
              <Input
                type="datetime-local"
                value={observedAt}
                max={localNow()}
                onChange={(e) => setObservedAt(e.target.value)}
              />
            </Field>
            <Field
              label="City"
              optional
              description={prompt ? `Country: ${prompt.country}` : undefined}
              error={fieldError('city')}
            >
              <Input
                value={city ?? prompt?.city ?? ''}
                onChange={(e) => setCity(e.target.value)}
                placeholder="Surat"
              />
            </Field>
          </div>
          <Field
            label="Note"
            optional
            description="Device, signed in or not, anything that may have changed the answer."
          >
            <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </Field>
          {save.isError && !(save.error instanceof ApiError && Object.keys(save.error.fieldErrors).length) ? (
            <Alert tone="danger">{errorMessage(save.error)}</Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={save.isPending}
              disabled={!promptId || answerText.trim().length < 20}
            >
              Save observation
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
