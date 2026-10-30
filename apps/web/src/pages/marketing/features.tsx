import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router';
import { CtaBand } from '@/components/marketing/blocks';
import { Section, SectionHeading } from '@/components/marketing/layout';
import { FEATURE_LINKS, FEATURE_PAGES, type FeatureKey } from '@/content/site';
import { Seo } from '@/lib/seo';
import { breadcrumbLd } from '@/lib/structured-data';

const EXTRA_CAPABILITIES = [
  {
    title: 'Keyword research',
    text: 'Lists, topic clusters, intent and priority, CSV import and export, and AI keyword ideas labeled as unmeasured.',
    to: '/how-it-works#keywords',
  },
  {
    title: 'Recommendations',
    text: 'Prioritized actions generated from audit and AI visibility evidence, with an accept, start, complete or dismiss workflow.',
    to: '/how-it-works#recommendations',
  },
  {
    title: 'Reports',
    text: 'HTML and PDF reports for a date range, built from stored project data, with data gaps stated plainly.',
    to: '/how-it-works#reports',
  },
  {
    title: 'Google Search Console',
    text: 'Connect a property with OAuth to bring clicks, impressions, CTR and position into the same workspace.',
    to: '/how-it-works#integrations',
  },
];

export function FeaturesPage() {
  return (
    <>
      <Seo
        title="Features"
        description="Technical SEO audits, AI visibility tracking, Content Studio, competitor analysis, keyword research, recommendations and reports in one workspace."
        path="/features"
        jsonLd={breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Features', path: '/features' },
        ])}
      />
      <Section className="pb-8 text-center">
        <p className="text-sm font-semibold tracking-wide text-indigo-300 uppercase">Features</p>
        <h1 className="mx-auto mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Everything you need to be found, quoted and cited
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-slate-300">
          Four core modules, built on one project and one dataset, so the audit, your content and AI
          visibility metrics inform each other.
        </p>
      </Section>
      <Section className="pt-0">
        <div className="grid gap-5 md:grid-cols-2">
          {FEATURE_LINKS.map(({ label, to, icon: Icon }) => {
            const key = to.split('/').pop() as FeatureKey;
            const page = FEATURE_PAGES[key];
            return (
              <Link
                key={to}
                to={to}
                className="group rounded-2xl border border-border bg-card p-7 transition-colors hover:border-indigo-400/40"
              >
                <span className="flex size-11 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Icon className="size-5" aria-hidden />
                </span>
                <h2 className="mt-5 text-xl font-semibold text-white">{label}</h2>
                <p className="mt-2 text-[15px] leading-relaxed text-slate-300">{page.description}</p>
                <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-indigo-300 group-hover:text-indigo-200">
                  Learn more <ArrowRight className="size-4" aria-hidden />
                </span>
              </Link>
            );
          })}
        </div>
      </Section>
      <Section className="border-t border-white/5">
        <SectionHeading
          title="Also included"
          text="The supporting tools that turn findings into finished work."
        />
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {EXTRA_CAPABILITIES.map((c) => (
            <Link
              key={c.title}
              to={c.to}
              className="rounded-2xl border border-border bg-card p-6 transition-colors hover:border-indigo-400/40"
            >
              <h3 className="font-semibold text-white">{c.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-300">{c.text}</p>
            </Link>
          ))}
        </div>
      </Section>
      <CtaBand />
    </>
  );
}

export function FeatureDetailPage({ feature }: { feature: FeatureKey }) {
  const page = FEATURE_PAGES[feature];
  const others = FEATURE_LINKS.filter((f) => f.to !== page.path);
  return (
    <>
      <Seo
        title={page.seoTitle}
        description={page.seoDescription}
        path={page.path}
        jsonLd={breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Features', path: '/features' },
          { name: page.eyebrow, path: page.path },
        ])}
      />
      <Section className="pb-10">
        <nav aria-label="Breadcrumb" className="text-sm text-slate-400">
          <Link to="/features" className="hover:text-white">
            Features
          </Link>{' '}
          / <span className="text-slate-300">{page.eyebrow}</span>
        </nav>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          {page.title}
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-300">{page.description}</p>
      </Section>
      <Section className="space-y-6 pt-0">
        {page.sections.map((section, index) => (
          <article
            key={section.title}
            className="grid gap-8 rounded-2xl border border-border bg-card p-6 sm:p-8 lg:grid-cols-[1.2fr_1fr]"
          >
            <div>
              <p className="text-sm font-semibold text-indigo-300">{String(index + 1).padStart(2, '0')}</p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">{section.title}</h2>
              <p className="mt-3 text-[15px] leading-relaxed text-slate-300">{section.text}</p>
            </div>
            <ul className="space-y-3 self-center">
              {section.bullets.map((b) => (
                <li key={b} className="flex gap-3 text-[15px] text-slate-200">
                  <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-indigo-300" aria-hidden />
                  {b}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </Section>
      <Section className="border-t border-white/5">
        <h2 className="text-xl font-semibold text-white">Other features</h2>
        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          {others.map(({ label, to, description, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex gap-3 rounded-xl border border-border bg-card p-5 transition-colors hover:border-indigo-400/40"
            >
              <Icon className="mt-0.5 size-5 shrink-0 text-indigo-300" aria-hidden />
              <span>
                <span className="block font-medium text-white">{label}</span>
                <span className="mt-1 block text-sm text-slate-400">{description}</span>
              </span>
            </Link>
          ))}
        </div>
      </Section>
      <CtaBand />
    </>
  );
}
