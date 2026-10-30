import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Logo } from '@/components/brand/logo';
import { Seo } from '@/lib/seo';

export function AuthLayout({
  title,
  description,
  seoTitle,
  path,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  seoTitle: string;
  path: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <Seo
        title={seoTitle}
        description={`${seoTitle} · Surfaced, the platform for SEO audits, answer-ready content and AI visibility tracking.`}
        path={path}
        noindex
      />
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
        <Logo />
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          Back to website
        </Link>
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pt-6 pb-16 sm:pt-12">
        <div className="w-full max-w-md">
          <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description ? <p className="mt-2 text-sm text-muted-foreground">{description}</p> : null}
            <div className="mt-6">{children}</div>
          </div>
          {footer ? <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
