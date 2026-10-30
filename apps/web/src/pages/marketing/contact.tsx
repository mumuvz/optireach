import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Mail } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { CONTACT_TOPICS, contactSchema } from '@surfaced/shared';
import type { z } from 'zod';
import { Section } from '@/components/marketing/layout';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/feedback';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/form';
import { api, ApiError, errorMessage } from '@/lib/api';
import { CONTACT_EMAIL } from '@/lib/config';
import { Seo } from '@/lib/seo';
import { breadcrumbLd } from '@/lib/structured-data';

type ContactIn = z.input<typeof contactSchema>;
type ContactOut = z.output<typeof contactSchema>;

const TOPIC_LABELS: Record<(typeof CONTACT_TOPICS)[number], string> = {
  sales: 'Sales and pricing',
  support: 'Product support',
  partnership: 'Partnerships and agencies',
  press: 'Press',
  privacy: 'Privacy and data requests',
  other: 'Something else',
};

export default function ContactPage() {
  const form = useForm<ContactIn, unknown, ContactOut>({
    resolver: zodResolver(contactSchema),
    defaultValues: { name: '', email: '', company: '', topic: 'sales', message: '', website: '' },
  });
  const send = useMutation({
    mutationFn: (values: ContactOut) => api.post<{ id: string; message: string }>('/public/contact', values),
    onError: (error) => {
      if (error instanceof ApiError) {
        for (const [field, message] of Object.entries(error.fieldErrors))
          form.setError(field as keyof ContactIn, { message });
      }
    },
  });
  const errors = form.formState.errors;

  return (
    <>
      <Seo
        title="Contact"
        description="Questions about Surfaced, pricing, agencies or your data? Send us a message and we will reply by email."
        path="/contact"
        jsonLd={breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Contact', path: '/contact' },
        ])}
      />
      <Section className="grid gap-12 lg:grid-cols-[1fr_1.2fr]">
        <div>
          <p className="text-sm font-semibold tracking-wide text-indigo-300 uppercase">Contact</p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white sm:text-5xl">Talk to us</h1>
          <p className="mt-5 text-lg leading-relaxed text-slate-300">
            Questions about plans, agency use, a data request or something that does not work as expected?
            Send a message and we will reply by email.
          </p>
          <p className="mt-8 flex items-center gap-2 text-slate-300">
            <Mail className="size-5 text-indigo-300" aria-hidden />
            <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white">
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6 sm:p-8">
          {send.isSuccess ? (
            <div className="flex flex-col items-center py-10 text-center" role="status">
              <CheckCircle2 className="size-10 text-emerald-300" aria-hidden />
              <h2 className="mt-4 text-xl font-semibold text-white">Message sent</h2>
              <p className="mt-2 max-w-sm text-slate-300">{send.data.message}</p>
              <Button
                variant="outline"
                className="mt-6"
                onClick={() => {
                  form.reset();
                  send.reset();
                }}
              >
                Send another message
              </Button>
            </div>
          ) : (
            <form onSubmit={form.handleSubmit((v) => send.mutate(v))} className="grid gap-5" noValidate>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Name" error={errors.name?.message}>
                  <Input autoComplete="name" {...form.register('name')} />
                </Field>
                <Field label="Work email" error={errors.email?.message}>
                  <Input type="email" autoComplete="email" {...form.register('email')} />
                </Field>
              </div>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Company" optional error={errors.company?.message}>
                  <Input autoComplete="organization" {...form.register('company')} />
                </Field>
                <Field label="Topic" error={errors.topic?.message}>
                  <NativeSelect {...form.register('topic')}>
                    {CONTACT_TOPICS.map((t) => (
                      <option key={t} value={t}>
                        {TOPIC_LABELS[t]}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              <Field label="Message" error={errors.message?.message}>
                <Textarea rows={6} {...form.register('message')} />
              </Field>
              {/* Honeypot: hidden from people, often filled in by bots. */}
              <div className="hidden" aria-hidden>
                <label htmlFor="contact-website">Website</label>
                <input id="contact-website" tabIndex={-1} autoComplete="off" {...form.register('website')} />
              </div>
              {send.isError &&
              !(send.error instanceof ApiError && Object.keys(send.error.fieldErrors).length) ? (
                <Alert tone="danger">{errorMessage(send.error)}</Alert>
              ) : null}
              <Button type="submit" size="lg" loading={send.isPending}>
                Send message
              </Button>
              <p className="text-[13px] text-muted-foreground">
                We use your details only to reply to this message.
              </p>
            </form>
          )}
        </div>
      </Section>
    </>
  );
}
