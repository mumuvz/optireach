import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MailCheck, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  type MeDto,
  type WorkspaceDto,
} from '@surfaced/shared';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Alert, Spinner } from '@/components/ui/feedback';
import { Checkbox, Field, FieldError, Input, Label } from '@/components/ui/form';
import { api, ApiError, errorMessage } from '@/lib/api';
import { ME_KEY, safeNextPath, useHydrated, useMe } from '@/lib/auth';
import { AuthLayout } from './auth-layout';

/** Applies API field errors to the form; returns true when at least one field matched. */
function applyFieldErrors<T extends Record<string, unknown>>(
  error: unknown,
  setError: (name: keyof T & string, e: { message: string }) => void,
  fields: readonly (keyof T & string)[],
): boolean {
  if (!(error instanceof ApiError)) return false;
  let matched = false;
  for (const [field, message] of Object.entries(error.fieldErrors)) {
    if ((fields as readonly string[]).includes(field)) {
      setError(field as keyof T & string, { message });
      matched = true;
    }
  }
  return matched;
}

/** Sends already signed-in visitors away from the login and register pages (not after a submit, which navigates itself). */
function useRedirectIfSignedIn(to: string, enabled: boolean) {
  const me = useMe();
  const navigate = useNavigate();
  useEffect(() => {
    if (enabled && me.data) void navigate(to, { replace: true });
  }, [enabled, me.data, navigate, to]);
}

// ---------------- Login ----------------

type LoginIn = z.input<typeof loginSchema>;

export function LoginPage() {
  const [params] = useSearchParams();
  const hydrated = useHydrated();
  const next = safeNextPath(params.get('next'));
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<LoginIn, unknown, z.output<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });
  const login = useMutation({
    mutationFn: (values: z.output<typeof loginSchema>) => api.post<MeDto>('/auth/login', values),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_KEY, me);
      void navigate(next, { replace: true });
    },
    onError: (error) => applyFieldErrors<LoginIn>(error, form.setError, ['email', 'password']),
  });
  useRedirectIfSignedIn(next, login.isIdle);
  const errors = form.formState.errors;
  const expired = hydrated && params.get('expired') === '1';

  return (
    <AuthLayout
      seoTitle="Log in"
      path="/login"
      title="Log in"
      description="Welcome back. Sign in to your workspace."
      footer={
        <>
          New to Surfaced?{' '}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Create an account
          </Link>
        </>
      }
    >
      <form onSubmit={form.handleSubmit((v) => login.mutate(v))} className="grid gap-4" noValidate>
        {expired ? <Alert tone="info">Your session ended. Please sign in again.</Alert> : null}
        <Field label="Email" error={errors.email?.message}>
          <Input type="email" autoComplete="email" autoFocus {...form.register('email')} />
        </Field>
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="login-password">Password</Label>
            <Link to="/forgot-password" className="text-[13px] font-medium text-primary hover:underline">
              Forgot password?
            </Link>
          </div>
          <Input
            id="login-password"
            type="password"
            autoComplete="current-password"
            aria-invalid={errors.password ? true : undefined}
            {...form.register('password')}
          />
          <FieldError>{errors.password?.message}</FieldError>
        </div>
        {login.isError &&
        !(login.error instanceof ApiError && Object.keys(login.error.fieldErrors).length) ? (
          <Alert tone="danger">{errorMessage(login.error)}</Alert>
        ) : null}
        <Button type="submit" size="lg" loading={login.isPending}>
          Log in
        </Button>
      </form>
    </AuthLayout>
  );
}

// ---------------- Register ----------------

const registerFormSchema = registerSchema.extend({
  workspaceName: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((v) => (v ? v : undefined))
    .pipe(z.string().min(2, 'Use at least 2 characters').optional()),
});
type RegisterIn = z.input<typeof registerFormSchema>;

const PLAN_NAMES: Record<string, string> = { STARTER: 'Starter', GROWTH: 'Growth', AGENCY: 'Agency' };

export function RegisterPage() {
  const [params] = useSearchParams();
  const hydrated = useHydrated();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const form = useForm<RegisterIn, unknown, z.output<typeof registerFormSchema>>({
    resolver: zodResolver(registerFormSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
      workspaceName: '',
      acceptTerms: false as unknown as true,
    },
  });
  const plan = hydrated ? params.get('plan') : null;
  const register = useMutation({
    mutationFn: (values: z.output<typeof registerFormSchema>) => api.post<MeDto>('/auth/register', values),
    onSuccess: (me) => {
      queryClient.setQueryData(ME_KEY, me);
      const search = new URLSearchParams(window.location.search);
      const chosen = search.get('plan');
      const interval = search.get('interval') === 'YEAR' ? 'YEAR' : 'MONTH';
      const next = search.get('next');
      const target = next
        ? safeNextPath(next)
        : chosen && PLAN_NAMES[chosen]
          ? `/app/billing?plan=${chosen}&interval=${interval}`
          : '/app/projects/new?welcome=1';
      void navigate(target, { replace: true });
    },
    onError: (error) =>
      applyFieldErrors<RegisterIn>(error, form.setError, ['name', 'email', 'password', 'workspaceName']),
  });
  useRedirectIfSignedIn(hydrated ? safeNextPath(params.get('next')) : '/app', register.isIdle);
  const errors = form.formState.errors;

  return (
    <AuthLayout
      seoTitle="Create an account"
      path="/register"
      title="Create your account"
      description={
        plan && PLAN_NAMES[plan]
          ? `Start with a free account, then confirm the ${PLAN_NAMES[plan]} plan in Billing.`
          : 'Free plan included. No credit card required.'
      }
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={form.handleSubmit((v) => register.mutate(v))} className="grid gap-4" noValidate>
        <Field label="Full name" error={errors.name?.message}>
          <Input autoComplete="name" autoFocus {...form.register('name')} />
        </Field>
        <Field label="Work email" error={errors.email?.message}>
          <Input type="email" autoComplete="email" {...form.register('email')} />
        </Field>
        <Field
          label="Password"
          error={errors.password?.message}
          description="At least 10 characters. A passphrase of a few words works well."
        >
          <Input type="password" autoComplete="new-password" {...form.register('password')} />
        </Field>
        <Field
          label="Workspace name"
          optional
          error={errors.workspaceName?.message}
          description="Usually your company or team. You can change it later."
        >
          <Input autoComplete="organization" {...form.register('workspaceName')} />
        </Field>
        <div className="grid gap-1.5">
          <div className="flex items-start gap-2.5">
            <Checkbox
              id="accept-terms"
              className="mt-0.5"
              checked={Boolean(form.watch('acceptTerms'))}
              onCheckedChange={(v) =>
                form.setValue('acceptTerms', (v === true) as true, {
                  shouldValidate: form.formState.isSubmitted,
                })
              }
              aria-invalid={errors.acceptTerms ? true : undefined}
            />
            <Label htmlFor="accept-terms" className="leading-snug font-normal text-muted-foreground">
              I agree to the{' '}
              <Link to="/terms" className="font-medium text-primary hover:underline" target="_blank">
                Terms of service
              </Link>{' '}
              and{' '}
              <Link to="/privacy" className="font-medium text-primary hover:underline" target="_blank">
                Privacy policy
              </Link>
              .
            </Label>
          </div>
          <FieldError>{errors.acceptTerms?.message}</FieldError>
        </div>
        {register.isError &&
        !(register.error instanceof ApiError && Object.keys(register.error.fieldErrors).length) ? (
          <Alert tone="danger">{errorMessage(register.error)}</Alert>
        ) : null}
        <Button type="submit" size="lg" loading={register.isPending}>
          Create account
        </Button>
      </form>
    </AuthLayout>
  );
}

// ---------------- Forgot / reset password ----------------

export function ForgotPasswordPage() {
  const form = useForm<z.input<typeof forgotPasswordSchema>, unknown, z.output<typeof forgotPasswordSchema>>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });
  const request = useMutation({
    mutationFn: (v: z.output<typeof forgotPasswordSchema>) => api.post('/auth/forgot-password', v),
  });
  return (
    <AuthLayout
      seoTitle="Reset your password"
      path="/forgot-password"
      title="Reset your password"
      description="Enter the email you signed up with. If an account exists, we will send a reset link."
      footer={
        <Link to="/login" className="font-medium text-primary hover:underline">
          Back to log in
        </Link>
      }
    >
      {request.isSuccess ? (
        <div className="flex flex-col items-center py-4 text-center" role="status">
          <MailCheck className="size-10 text-primary" aria-hidden />
          <p className="mt-3 font-medium">Check your inbox</p>
          <p className="mt-1 text-sm text-muted-foreground">
            If an account exists for {form.getValues('email')}, a reset link is on its way. The link expires
            in 1 hour.
          </p>
        </div>
      ) : (
        <form onSubmit={form.handleSubmit((v) => request.mutate(v))} className="grid gap-4" noValidate>
          <Field label="Email" error={form.formState.errors.email?.message}>
            <Input type="email" autoComplete="email" autoFocus {...form.register('email')} />
          </Field>
          {request.isError ? <Alert tone="danger">{errorMessage(request.error)}</Alert> : null}
          <Button type="submit" size="lg" loading={request.isPending}>
            Send reset link
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

const resetFormSchema = z
  .object({ password: resetPasswordSchema.shape.password, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'The passwords do not match' });

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const hydrated = useHydrated();
  const token = hydrated ? params.get('token') : null;
  const form = useForm<z.input<typeof resetFormSchema>, unknown, z.output<typeof resetFormSchema>>({
    resolver: zodResolver(resetFormSchema),
    defaultValues: { password: '', confirm: '' },
  });
  const reset = useMutation({
    mutationFn: (v: z.output<typeof resetFormSchema>) =>
      api.post('/auth/reset-password', { token, password: v.password }),
    onError: (error) => applyFieldErrors<z.input<typeof resetFormSchema>>(error, form.setError, ['password']),
  });
  return (
    <AuthLayout
      seoTitle="Choose a new password"
      path="/reset-password"
      title="Choose a new password"
      description="After the change, you will be signed out on all devices."
    >
      {!hydrated ? (
        <Spinner />
      ) : !token ? (
        <Alert tone="warning" title="This reset link is incomplete">
          Open the link from your email again, or{' '}
          <Link to="/forgot-password" className="font-medium underline">
            request a new one
          </Link>
          .
        </Alert>
      ) : reset.isSuccess ? (
        <div className="flex flex-col items-center py-4 text-center" role="status">
          <CheckCircle2 className="size-10 text-success" aria-hidden />
          <p className="mt-3 font-medium">Your password was changed</p>
          <Button asChild className="mt-5">
            <Link to="/login">Log in</Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={form.handleSubmit((v) => reset.mutate(v))} className="grid gap-4" noValidate>
          <Field
            label="New password"
            error={form.formState.errors.password?.message}
            description="At least 10 characters."
          >
            <Input type="password" autoComplete="new-password" autoFocus {...form.register('password')} />
          </Field>
          <Field label="Confirm new password" error={form.formState.errors.confirm?.message}>
            <Input type="password" autoComplete="new-password" {...form.register('confirm')} />
          </Field>
          {reset.isError && !(reset.error instanceof ApiError && reset.error.fieldErrors.password) ? (
            <Alert tone="danger">
              {errorMessage(reset.error)}{' '}
              <Link to="/forgot-password" className="font-medium underline">
                Request a new link
              </Link>
            </Alert>
          ) : null}
          <Button type="submit" size="lg" loading={reset.isPending}>
            Change password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

// ---------------- Email verification and invitations (SPA routes) ----------------

/** Runs a token-based POST once after mount (StrictMode-safe). */
function useTokenAction<T>(path: string, token: string | null) {
  const mutation = useMutation({ mutationFn: () => api.post<T>(path, { token }) });
  const started = useRef(false);
  useEffect(() => {
    if (token && !started.current) {
      started.current = true;
      mutation.mutate();
    }
  }, [token, mutation]);
  return mutation;
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const queryClient = useQueryClient();
  const me = useMe();
  const verify = useTokenAction('/auth/verify-email', token);
  useEffect(() => {
    if (verify.isSuccess) void queryClient.invalidateQueries({ queryKey: ME_KEY });
  }, [verify.isSuccess, queryClient]);
  return (
    <AuthLayout seoTitle="Verify your email" path="/verify-email" title="Email verification">
      {!token ? (
        <Alert tone="warning">
          This verification link is incomplete. Open the link from your email again.
        </Alert>
      ) : verify.isPending || verify.isIdle ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner /> Verifying your email address…
        </p>
      ) : verify.isSuccess ? (
        <div className="flex flex-col items-center py-4 text-center" role="status">
          <CheckCircle2 className="size-10 text-success" aria-hidden />
          <p className="mt-3 font-medium">Your email address is verified</p>
          <Button asChild className="mt-5">
            <Link to={me.data ? '/app' : '/login'}>{me.data ? 'Go to the dashboard' : 'Log in'}</Link>
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-center py-4 text-center" role="alert">
          <XCircle className="size-10 text-destructive" aria-hidden />
          <p className="mt-3 font-medium">We could not verify this link</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {errorMessage(verify.error)} You can request a new link from the dashboard.
          </p>
          <Button asChild variant="outline" className="mt-5">
            <Link to={me.data ? '/app/settings' : '/login'}>{me.data ? 'Open settings' : 'Log in'}</Link>
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}

export function AcceptInvitationPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [accepted, setAccepted] = useState(false);
  const accept = useMutation({
    // The API also makes the joined workspace the current one.
    mutationFn: () => api.post<WorkspaceDto>('/workspaces/invitations/accept', { token }),
    onSuccess: async () => {
      setAccepted(true);
      await queryClient.invalidateQueries();
      void navigate('/app', { replace: true });
    },
  });
  const here = `/invite/accept?token=${encodeURIComponent(token ?? '')}`;
  return (
    <AuthLayout
      seoTitle="Join a workspace"
      path="/invite/accept"
      title="Join a workspace"
      description="You have been invited to collaborate in a Surfaced workspace."
    >
      {!token ? (
        <Alert tone="warning">This invitation link is incomplete. Open the link from your email again.</Alert>
      ) : me.isPending ? (
        <Spinner />
      ) : !me.data ? (
        <div className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            Log in or create an account with the email address the invitation was sent to.
          </p>
          <Button asChild>
            <Link to={`/login?next=${encodeURIComponent(here)}`}>Log in to accept</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to={`/register?next=${encodeURIComponent(here)}`}>Create an account</Link>
          </Button>
        </div>
      ) : (
        <div className="grid gap-4">
          <p className="text-sm">
            Signed in as <span className="font-medium">{me.data.user.email}</span>.
          </p>
          {accept.isError ? <Alert tone="danger">{errorMessage(accept.error)}</Alert> : null}
          <Button size="lg" loading={accept.isPending || accepted} onClick={() => accept.mutate()}>
            Accept invitation
          </Button>
        </div>
      )}
    </AuthLayout>
  );
}
