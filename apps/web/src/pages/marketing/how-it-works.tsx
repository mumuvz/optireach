import { CtaBand } from '@/components/marketing/blocks';
import { Section } from '@/components/marketing/layout';
import { STEPS } from '@/content/site';
import { Seo } from '@/lib/seo';
import { breadcrumbLd } from '@/lib/structured-data';

const DETAILS = [
  {
    id: 'projects',
    title: 'Create a project',
    text: 'Add your website, industry, target countries and languages, your main competitors and the keywords you care about. The website address is checked so that only public sites on standard ports can be crawled.',
  },
  {
    id: 'audit',
    title: 'Run the audit',
    text: 'The crawler reads robots.txt and your sitemaps, then follows internal links to every page it is allowed to crawl (you can set a page cap per project). Each page is checked against 55 deterministic rules. Issues are stored with evidence and tracked across audits, and you can schedule weekly or monthly re-audits.',
  },
  {
    id: 'visibility',
    title: 'Track AI visibility',
    text: 'Add prompts such as “best project management tool for agencies”, choose providers, countries and languages, and run them on demand or on a schedule. Surfaced stores every answer and calculates mention rate, citation rate and share of voice from those stored observations.',
  },
  {
    id: 'keywords',
    title: 'Organize keywords',
    text: 'Group keywords into lists and topic clusters with intent and priority. Import or export CSV files. AI keyword ideas are labeled as unmeasured, and search volumes appear only when a licensed data provider is connected.',
  },
  {
    id: 'recommendations',
    title: 'Work through recommendations',
    text: 'Recommendations come from audit findings and AI visibility gaps, each with evidence and a suggested next step. Accept, assign, complete or dismiss them. Fixed issues are confirmed by the next crawl.',
  },
  {
    id: 'content',
    title: 'Draft and review content',
    text: 'Content Studio turns briefs into outlines, drafts, meta tags, FAQs and structured data. Every save creates a version, and drafts are approved by an owner or admin before anyone publishes them. Nothing is pushed to your website automatically.',
  },
  {
    id: 'reports',
    title: 'Report progress',
    text: 'Generate an HTML or PDF report for any date range. Reports use the data stored for the project and state plainly what is missing, for example when no audit ran in the period.',
  },
  {
    id: 'integrations',
    title: 'Connect Google Search Console',
    text: 'Connect a Search Console property with Google sign-in to bring clicks, impressions, CTR and average position into your reports. Access tokens are encrypted, and you can disconnect at any time.',
  },
];

export default function HowItWorksPage() {
  return (
    <>
      <Seo
        title="How it works"
        description="How Surfaced audits your website, tracks AI visibility, turns findings into recommendations and content, and reports progress from stored data."
        path="/how-it-works"
        jsonLd={breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'How it works', path: '/how-it-works' },
        ])}
      />
      <Section className="pb-10 text-center">
        <p className="text-sm font-semibold tracking-wide text-indigo-300 uppercase">How it works</p>
        <h1 className="mx-auto mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Audit, improve, measure, and repeat
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-slate-300">
          A simple loop, with the evidence for every step kept next to the result.
        </p>
      </Section>
      <Section className="pt-0">
        <ol className="grid gap-5 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-2xl border border-border bg-card p-6">
              <span className="text-sm font-semibold text-indigo-300">Step {index + 1}</span>
              <h2 className="mt-2 text-xl font-semibold text-white">{step.title}</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-slate-300">{step.text}</p>
            </li>
          ))}
        </ol>
      </Section>
      <Section className="max-w-4xl border-t border-white/5">
        <h2 className="text-2xl font-semibold tracking-tight text-white">Step by step</h2>
        <div className="mt-8 space-y-4">
          {DETAILS.map((d, index) => (
            <section
              key={d.id}
              id={d.id}
              className="scroll-mt-24 rounded-2xl border border-border bg-card p-6"
            >
              <h3 className="flex items-baseline gap-3 text-lg font-semibold text-white">
                <span className="text-sm text-indigo-300 tabular-nums">
                  {String(index + 1).padStart(2, '0')}
                </span>
                {d.title}
              </h3>
              <p className="mt-2 text-[15px] leading-relaxed text-slate-300">{d.text}</p>
            </section>
          ))}
        </div>
      </Section>
      <CtaBand />
    </>
  );
}
