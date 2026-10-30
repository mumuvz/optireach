import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  BUSINESS_GOALS,
  BUSINESS_GOAL_LABELS,
  BUSINESS_TYPES,
  BUSINESS_TYPE_LABELS,
  INDUSTRIES,
  PROFILE_PRESENCE,
  PROFILE_PRESENCE_LABELS,
  countryOptions,
  languageOptions,
  projectCreateSchema,
  type BusinessType,
  type ProjectCreateInput,
  type ProjectDto,
} from '@surfaced/shared';
import type { z } from 'zod';
import { usePlanLimits, useWorkspaceId } from '@/app/queries';
import { PageHeader } from '@/components/app/page';
import {
  LocationEditor,
  emptyLocationDraft,
  validateLocationDraft,
  type LocationDraft,
} from '@/components/local/location-editor';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert } from '@/components/ui/feedback';
import { Checkbox, Field, Input, Label, NativeSelect, Textarea } from '@/components/ui/form';
import { MultiSelect, TagInput } from '@/components/ui/multi-select';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useHydrated } from '@/lib/auth';
import { cn } from '@/lib/cn';

type FormIn = ProjectCreateInput;
type FormOut = z.output<typeof projectCreateSchema>;

const STEPS = ['Business', 'Type and presence', 'Location', 'Markets and targets', 'Review'] as const;
const LOCAL_TYPES: BusinessType[] = ['LOCAL_STOREFRONT', 'SERVICE_AREA', 'RETAIL_STORE', 'MULTI_LOCATION'];

/** What OptiReach will do for this business, split by whether a website is needed. */
function Plan({
  hasWebsite,
  types,
  presence,
  merchant,
  hasLocation,
}: {
  hasWebsite: boolean;
  types: BusinessType[];
  presence: string;
  merchant: boolean;
  hasLocation: boolean;
}) {
  // prettier-ignore
  const noWebsite = [
    hasLocation ? 'Track your Google Maps and local-pack positions for your keywords on a grid around each location.' : 'Add a location later to track Google Maps positions around it.', // prettier-ignore
    'Find the local competitors that appear around you, with their public ratings and review counts.',
    'Track how often AI answers (ChatGPT, approximated through OpenAI) mention your business.',
    presence === 'NONE'
      ? 'You have no Business Profile yet: creating one at business.google.com is the most important step for Maps. OptiReach can then audit it once connected.'
      : 'Connect your Business Profile to audit its information and follow its reviews.',
    ...(merchant || types.includes('MERCHANT_SELLER') ? ['Check product data for Merchant Center (connection or feed import) against Google’s requirements for your country.'] : []), // prettier-ignore
  ];
  const website = [
    'Audit the website: crawlability, titles, headings, structured data, internal links and speed.',
    'Compare your site with competitors and find search terms your pages do not target yet.',
    'Connect Search Console to see clicks, impressions and positions.',
  ];
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold">Works without a website</h3>
        <ul className="mt-2 space-y-1.5 text-sm">
          {noWebsite.map((t) => (
            <li key={t} className="flex gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> {t}
            </li>
          ))}
        </ul>
      </div>
      <div className={cn('rounded-lg border border-border p-4', !hasWebsite && 'opacity-70')}>
        <h3 className="text-sm font-semibold">
          {hasWebsite ? 'With your website' : 'Needs a website (add one any time)'}
        </h3>
        <ul className="mt-2 space-y-1.5 text-sm">
          {website.map((t) => (
            <li key={t} className="flex gap-2">
              <Check
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  hasWebsite ? 'text-emerald-600' : 'text-muted-foreground',
                )}
                aria-hidden
              />{' '}
              {t} {/* prettier-ignore */}
            </li>
          ))}
        </ul>
        {!hasWebsite ? (
          <p className="mt-2 text-[13px] text-muted-foreground">
            Website checks are skipped, not counted as failures, while there is no website.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function NewProjectPage() {
  const workspaceId = useWorkspaceId();
  const limits = usePlanLimits();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const hydrated = useHydrated();
  const welcome = hydrated && params.get('welcome') === '1';
  const countries = useMemo(() => countryOptions().map((o) => ({ value: o.code, label: o.name })), []);
  const languages = useMemo(() => languageOptions().map((o) => ({ value: o.code, label: o.name })), []);

  const [step, setStep] = useState(0);
  const [noWebsite, setNoWebsite] = useState(false);
  const [runAudit, setRunAudit] = useState(true);
  const [withLocation, setWithLocation] = useState<boolean | null>(null);
  const [location, setLocation] = useState<LocationDraft>(() => emptyLocationDraft());
  const [locationErrors, setLocationErrors] = useState<Record<string, string>>({});
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(projectCreateSchema),
    defaultValues: {
      name: '',
      websiteUrl: '',
      industry: undefined,
      description: '',
      targetCountries: ['US'],
      targetLanguages: ['en'],
      competitors: [],
      primaryKeywords: [],
      brandVoice: '',
      auditSchedule: 'MANUAL',
      businessProfile: { types: [], profilePresence: 'UNKNOWN', secondaryCategories: [], services: [], products: [], localities: [], socialProfiles: [], directories: [], goals: [] }, // prettier-ignore
    },
  });
  const competitors = useFieldArray({ control: form.control, name: 'competitors' });
  const errors = form.formState.errors;
  const types = (form.watch('businessProfile.types') ?? []) as BusinessType[];
  const presence = form.watch('businessProfile.profilePresence') ?? 'UNKNOWN';
  const merchant = form.watch('businessProfile.hasMerchantCenter') ?? false;
  const localBusiness = types.some((t) => LOCAL_TYPES.includes(t));
  const addLocation = withLocation ?? localBusiness;

  const create = useMutation({
    mutationFn: async ({ values, audit }: { values: FormOut; audit: boolean }) => {
      const project = await api.post<ProjectDto>('/projects', { ...values, workspaceId });
      let auditRunId: string | null = null;
      if (audit && project.websiteUrl) {
        try {
          auditRunId = (await api.post<{ auditRunId: string }>(`/projects/${project.id}/audits`, {}))
            .auditRunId;
        } catch (error) {
          toast.error('The project was created, but the first audit could not start', { description: errorMessage(error) }); // prettier-ignore
        }
      }
      return { project, auditRunId };
    },
    onSuccess: async ({ project, auditRunId }) => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      toast.success(`${project.name} created`);
      void navigate(auditRunId ? `/app/p/${project.id}/audits/${auditRunId}` : project.websiteUrl ? `/app/p/${project.id}` : `/app/p/${project.id}/local`); // prettier-ignore
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        for (const [field, message] of Object.entries(error.fieldErrors))
          form.setError(field as keyof FormIn, { message });
        const first = Object.keys(error.fieldErrors)[0] ?? '';
        if (first === 'name' || first === 'websiteUrl') setStep(0);
        else if (first.startsWith('locations')) setStep(2);
      }
    },
  });

  const next = async () => {
    if (step === 0) {
      if (noWebsite) form.setValue('websiteUrl', null);
      const ok = await form.trigger(
        noWebsite ? ['name', 'description'] : ['name', 'websiteUrl', 'description'],
      );
      if (!ok) return;
      if (!location.name) setLocation((l) => ({ ...l, name: form.getValues('name') }));
    }
    if (step === 1 && !(await form.trigger(['businessProfile']))) return;
    if (step === 2 && addLocation) {
      const { errors: e } = validateLocationDraft(location);
      setLocationErrors(e);
      if (Object.keys(e).length) return;
      const countriesNow = form.getValues('targetCountries') ?? [];
      if (!countriesNow.includes(location.country)) form.setValue('targetCountries', [location.country, ...countriesNow.filter((c) => c !== 'US' || countriesNow.length > 1)].slice(0, 25)); // prettier-ignore
    }
    if (step === 3 && !(await form.trigger(['targetCountries', 'targetLanguages', 'competitors', 'primaryKeywords']))) return; // prettier-ignore
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  const submit = form.handleSubmit((values) => {
    const loc = addLocation ? validateLocationDraft(location) : null;
    if (loc && !loc.data) {
      setLocationErrors(loc.errors);
      setStep(2);
      return;
    }
    create.mutate({
      values: {
        ...values,
        websiteUrl: noWebsite ? null : values.websiteUrl,
        locations: loc?.data ? [loc.data] : [],
      },
      audit: runAudit && !noWebsite,
    });
  });
  const generalError =
    create.isError && !(create.error instanceof ApiError && Object.keys(create.error.fieldErrors).length) ? errorMessage(create.error) : null; // prettier-ignore

  const toggleType = (t: BusinessType, on: boolean) => {
    const current = form.getValues('businessProfile.types') ?? [];
    form.setValue(
      'businessProfile.types',
      on ? [...new Set([...current, t])] : current.filter((x) => x !== t),
    );
  };

  return (
    <>
      <PageHeader
        title={welcome ? 'Welcome! Tell us about the business' : 'New project'}
        description="A project is one business. A website is optional: local businesses can be managed through their listings alone."
        breadcrumbs={[{ label: 'Projects', to: '/app/projects' }, { label: 'New project' }]}
      />
      <ol className="mb-5 flex max-w-3xl flex-wrap gap-2" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs',
                i === step ? 'border-primary bg-accent font-medium text-accent-foreground' : i < step ? 'border-border text-foreground' : 'border-border text-muted-foreground', // prettier-ignore
              )}
              aria-current={i === step ? 'step' : undefined}
            >
              {i + 1}. {s}
            </span>
          </li>
        ))}
      </ol>
      <form onSubmit={submit} className="grid max-w-3xl gap-5" noValidate>
        {step === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>Business</CardTitle>
              <CardDescription>Only public websites on standard ports can be audited.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Business name" error={errors.name?.message}>
                  <Input autoFocus {...form.register('name')} />
                </Field>
                <Field
                  label="Website"
                  error={errors.websiteUrl?.message}
                  description={
                    noWebsite
                      ? 'No website: local features only.'
                      : 'For example example.com or https://www.example.com'
                  }
                >
                  <Input
                    inputMode="url"
                    autoComplete="url"
                    placeholder="example.com"
                    disabled={noWebsite}
                    {...form.register('websiteUrl')}
                  />
                </Field>
              </div>
              <div className="flex items-center gap-2.5">
                <Checkbox
                  id="no-website"
                  checked={noWebsite}
                  onCheckedChange={(v) => {
                    setNoWebsite(v === true);
                    form.clearErrors('websiteUrl');
                  }}
                />
                <Label htmlFor="no-website" className="font-normal">
                  This business has no website
                </Label>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Industry" optional error={errors.industry?.message}>
                  <NativeSelect {...form.register('industry', { setValueAs: (v: string) => v || undefined })}>
                    <option value="">Choose an industry</option>
                    {INDUSTRIES.map((i) => (
                      <option key={i.key} value={i.key}>
                        {i.label}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field
                  label="Audit schedule"
                  error={errors.auditSchedule?.message}
                  description={
                    noWebsite
                      ? 'Audits need a website.'
                      : limits && !limits.scheduledAudits
                        ? 'Scheduled audits are available on paid plans.'
                        : 'Re-audit automatically to catch regressions.'
                  }
                >
                  <NativeSelect {...form.register('auditSchedule')} disabled={noWebsite}>
                    <option value="MANUAL">Manual only</option>
                    <option value="WEEKLY" disabled={!limits?.scheduledAudits}>
                      Weekly
                    </option>
                    <option value="MONTHLY" disabled={!limits?.scheduledAudits}>
                      Monthly
                    </option>
                  </NativeSelect>
                </Field>
              </div>
              <Field
                label="What does the business do?"
                optional
                error={errors.description?.message}
                description="Used to keep AI suggestions relevant. A few sentences are enough."
              >
                <Textarea rows={3} {...form.register('description')} />
              </Field>
            </CardContent>
          </Card>
        ) : null}

        {step === 1 ? (
          <Card>
            <CardHeader>
              <CardTitle>Type and presence</CardTitle>
              <CardDescription>
                Choose every description that fits. Nothing here is checked against Google until you connect
                an account.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-5">
              <fieldset className="grid gap-2 sm:grid-cols-2">
                <legend className="mb-1 text-sm font-medium">Business type</legend>
                {BUSINESS_TYPES.map((t) => (
                  <label key={t} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={types.includes(t)}
                      onCheckedChange={(v) => toggleType(t, v === true)}
                      aria-label={BUSINESS_TYPE_LABELS[t]}
                    />
                    {BUSINESS_TYPE_LABELS[t]}
                  </label>
                ))}
              </fieldset>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Primary category"
                  optional
                  description="As customers would search, e.g. Jewellery store"
                >
                  <Input
                    {...form.register('businessProfile.primaryCategory', {
                      setValueAs: (v: string) => v || null,
                    })}
                  />
                </Field>
                <Field label="Other categories" optional description="Press Enter after each.">
                  <Controller
                    control={form.control}
                    name="businessProfile.secondaryCategories"
                    render={({ field }) => (
                      <TagInput
                        value={field.value ?? []}
                        onChange={field.onChange}
                        max={10}
                        placeholder="e.g. Gold dealer"
                      />
                    )}
                  />
                </Field>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Google Business Profile">
                  <NativeSelect {...form.register('businessProfile.profilePresence')}>
                    {PROFILE_PRESENCE.filter((p) => p !== 'CONNECTED').map((p) => (
                      <option key={p} value={p}>
                        {PROFILE_PRESENCE_LABELS[p]}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field label="Legal name" optional description="If different from the name customers see">
                  <Input
                    {...form.register('businessProfile.legalName', { setValueAs: (v: string) => v || null })}
                  />
                </Field>
              </div>
              <div className="grid gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <Controller
                    control={form.control}
                    name="businessProfile.hasMerchantCenter"
                    render={({ field }) => (
                      <Checkbox
                        checked={field.value ?? false}
                        onCheckedChange={(v) => field.onChange(v === true)}
                        aria-label="Uses Google Merchant Center"
                      />
                    )}
                  />
                  Uses (or wants to use) Google Merchant Center for products
                </label>
                {merchant ? (
                  <Field
                    label="Product feed URL"
                    optional
                    error={errors.businessProfile?.productFeedUrl?.message}
                    description="A feed file Google already reads, if you have one."
                  >
                    <Input
                      inputMode="url"
                      placeholder="https://"
                      {...form.register('businessProfile.productFeedUrl', {
                        setValueAs: (v: string) => v || null,
                      })}
                    />
                  </Field>
                ) : null}
              </div>
              <fieldset className="grid gap-2 sm:grid-cols-2">
                <legend className="mb-1 text-sm font-medium">Goals</legend>
                {BUSINESS_GOALS.map((g) => (
                  <Controller
                    key={g}
                    control={form.control}
                    name="businessProfile.goals"
                    render={({ field }) => (
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={(field.value ?? []).includes(g)}
                          onCheckedChange={(v) => field.onChange(v === true ? [...(field.value ?? []), g] : (field.value ?? []).filter((x) => x !== g))} // prettier-ignore
                          aria-label={BUSINESS_GOAL_LABELS[g]}
                        />
                        {BUSINESS_GOAL_LABELS[g]}
                      </label>
                    )}
                  />
                ))}
              </fieldset>
            </CardContent>
          </Card>
        ) : null}

        {step === 2 ? (
          <Card>
            <CardHeader>
              <CardTitle>Location</CardTitle>
              <CardDescription>
                Where customers visit you, or the area you serve. More branches can be added later.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex items-center gap-2.5">
                <Checkbox
                  id="with-location"
                  checked={addLocation}
                  onCheckedChange={(v) => setWithLocation(v === true)}
                />
                <Label htmlFor="with-location" className="font-normal">
                  Add a location now {localBusiness ? '' : '(not needed for online-only businesses)'}
                </Label>
              </div>
              {addLocation ? (
                <LocationEditor
                  value={location}
                  onChange={setLocation}
                  errors={locationErrors}
                  workspaceId={workspaceId ?? null}
                />
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {step === 3 ? (
          <Card>
            <CardHeader>
              <CardTitle>Markets and targets</CardTitle>
              <CardDescription>
                What you sell, where, and who you compete with. You can change all of this later.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Target countries"
                  error={errors.targetCountries?.message ?? errors.targetCountries?.root?.message}
                >
                  <Controller
                    control={form.control}
                    name="targetCountries"
                    render={({ field }) => (
                      <MultiSelect
                        options={countries}
                        value={field.value}
                        onChange={field.onChange}
                        max={25}
                        placeholder="Choose countries"
                      />
                    )}
                  />
                </Field>
                <Field
                  label="Languages"
                  error={errors.targetLanguages?.message ?? errors.targetLanguages?.root?.message}
                >
                  <Controller
                    control={form.control}
                    name="targetLanguages"
                    render={({ field }) => (
                      <MultiSelect
                        options={languages}
                        value={field.value}
                        onChange={field.onChange}
                        max={10}
                        placeholder="Choose languages"
                      />
                    )}
                  />
                </Field>
              </div>
              <Field
                label="Primary keywords"
                optional
                error={errors.primaryKeywords?.message}
                description="What customers search, e.g. “jewellers in Surat”. Press Enter after each."
              >
                <Controller
                  control={form.control}
                  name="primaryKeywords"
                  render={({ field }) => (
                    <TagInput
                      value={field.value ?? []}
                      onChange={field.onChange}
                      placeholder="e.g. bridal jewellery"
                    />
                  )}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Products" optional>
                  <Controller
                    control={form.control}
                    name="businessProfile.products"
                    render={({ field }) => (
                      <TagInput
                        value={field.value ?? []}
                        onChange={field.onChange}
                        placeholder="e.g. gold necklaces"
                      />
                    )}
                  />
                </Field>
                <Field label="Services" optional>
                  <Controller
                    control={form.control}
                    name="businessProfile.services"
                    render={({ field }) => (
                      <TagInput
                        value={field.value ?? []}
                        onChange={field.onChange}
                        placeholder="e.g. custom designs"
                      />
                    )}
                  />
                </Field>
                <Field label="Localities" optional description="Neighbourhoods you want to be found in">
                  <Controller
                    control={form.control}
                    name="businessProfile.localities"
                    render={({ field }) => (
                      <TagInput
                        value={field.value ?? []}
                        onChange={field.onChange}
                        placeholder="e.g. Mota Varachha"
                      />
                    )}
                  />
                </Field>
              </div>
              <div className="grid gap-2">
                <Label>
                  Competitors with a website{' '}
                  {limits ? (
                    <span className="font-normal text-muted-foreground">
                      (up to {limits.competitorsPerProject} on your plan)
                    </span>
                  ) : null}{' '}
                  {/* prettier-ignore */}
                </Label>
                {competitors.fields.map((field, index) => (
                  <div key={field.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <Input
                      aria-label={`Competitor ${index + 1} name`}
                      placeholder="Name"
                      {...form.register(`competitors.${index}.name`)}
                      aria-invalid={errors.competitors?.[index]?.name ? true : undefined}
                    />
                    <Input
                      aria-label={`Competitor ${index + 1} domain`}
                      placeholder="competitor.com"
                      {...form.register(`competitors.${index}.domain`)}
                      aria-invalid={errors.competitors?.[index]?.domain ? true : undefined}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => competitors.remove(index)}
                      aria-label={`Remove competitor ${index + 1}`}
                    >
                      <Trash2 />
                    </Button>
                    {errors.competitors?.[index] ? (
                      <p className="text-[13px] text-destructive sm:col-span-3" role="alert">
                        {errors.competitors[index]?.name?.message ??
                          errors.competitors[index]?.domain?.message}
                      </p>
                    ) : null}
                  </div>
                ))}
                <div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => competitors.append({ name: '', domain: '' })}
                    disabled={limits ? competitors.fields.length >= limits.competitorsPerProject : false}
                  >
                    <Plus /> Add competitor
                  </Button>
                </div>
                <p className="text-[13px] text-muted-foreground">
                  Local competitors without websites are found from your local rank scans.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Social profiles"
                  optional
                  error={errors.businessProfile?.socialProfiles?.message}
                  description="Full URLs. Press Enter after each."
                >
                  <Controller
                    control={form.control}
                    name="businessProfile.socialProfiles"
                    render={({ field }) => (
                      <TagInput
                        value={field.value ?? []}
                        onChange={field.onChange}
                        max={20}
                        placeholder="https://instagram.com/…"
                      />
                    )}
                  />
                </Field>
                <Field
                  label="Business directories"
                  optional
                  error={errors.businessProfile?.directories?.message}
                  description="Listings you already have, e.g. Justdial"
                >
                  <Controller
                    control={form.control}
                    name="businessProfile.directories"
                    render={({ field }) => (
                      <TagInput
                        value={field.value ?? []}
                        onChange={field.onChange}
                        max={20}
                        placeholder="https://…"
                      />
                    )}
                  />
                </Field>
              </div>
              <Field
                label="Brand voice"
                optional
                error={errors.brandVoice?.message}
                description="How content should sound, e.g. “plain, practical, no hype”."
              >
                <Textarea rows={2} {...form.register('brandVoice')} />
              </Field>
            </CardContent>
          </Card>
        ) : null}

        {step === 4 ? (
          <Card>
            <CardHeader>
              <CardTitle>Your plan</CardTitle>
              <CardDescription>
                Based on what you told us. Nothing is promised: rankings depend on Google, and every result is
                measured, not guessed.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Plan
                hasWebsite={!noWebsite}
                types={types}
                presence={presence}
                merchant={merchant}
                hasLocation={addLocation}
              />
              {!noWebsite ? (
                <div className="flex items-center gap-2.5">
                  <Checkbox
                    id="run-audit"
                    checked={runAudit}
                    onCheckedChange={(v) => setRunAudit(v === true)}
                  />
                  <Label htmlFor="run-audit" className="font-normal">
                    Run the first audit now
                  </Label>
                </div>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {generalError ? <Alert tone="danger">{generalError}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          {step > 0 ? (
            <Button type="button" variant="outline" size="lg" onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          ) : null}
          {/* Distinct keys: reusing one element and switching its type to "submit" while the Next click is being
              handled would submit the form and skip the review step. */}
          {step < STEPS.length - 1 ? (
            <Button key="next" type="button" size="lg" onClick={() => void next()}>
              Next
            </Button>
          ) : (
            <Button key="submit" type="submit" size="lg" loading={create.isPending}>
              Create project
            </Button>
          )}
          <Button asChild type="button" variant="ghost" size="lg">
            <Link to="/app/projects">Cancel</Link>
          </Button>
        </div>
      </form>
    </>
  );
}
