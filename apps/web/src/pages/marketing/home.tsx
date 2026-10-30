import {
  ArrowRight,
  Building2,
  CheckCircle2,
  FileText,
  Megaphone,
  Radar,
  Rocket,
  ShieldCheck,
} from 'lucide-react';
import { Link } from 'react-router';
import { CtaBand, DashboardPreview, FreeAuditForm } from '@/components/marketing/blocks';
import { Section, SectionHeading } from '@/components/marketing/layout';
import { PricingCards } from '@/components/marketing/pricing';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/tabs';
import { HOME_FAQ, PILLARS, STEPS } from '@/content/site';
import { Seo } from '@/lib/seo';
import { faqLd, organizationLd, softwareApplicationLd, websiteLd } from '@/lib/structured-data';

const USE_CASES = [
  {
    icon: Megaphone,
    title: 'In-house marketing teams',
    text: 'Keep one prioritized list of technical fixes, content work and AI visibility gaps, with an approval workflow for anything that ships.',
  },
  {
    icon: Building2,
    title: 'Agencies',
    text: 'Run audits and visibility tracking for several clients in separate projects, and send white-label reports built from real data.',
  },
  {
    icon: Rocket,
    title: 'Founders and small teams',
    text: 'Find out what blocks your site from being found or cited, fix the important things first, and see whether the changes worked.',
  },
];

export default function HomePage() {
  return (
    <>
      <Seo
        title="Surfaced — SEO, AEO and AI visibility platform"
        description="Audit your website, make your content answer-ready, and track how AI assistants mention and cite your brand, with metrics calculated from stored data."
        path="/"
        jsonLd={[organizationLd(), websiteLd(), softwareApplicationLd(), faqLd(HOME_FAQ)]}
      />

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(99,102,241,0.28),transparent)]"
          aria-hidden
        />
        <div className="relative mx-auto max-w-7xl px-4 pt-16 pb-12 text-center sm:px-6 sm:pt-24 lg:px-8">
          <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-indigo-400/25 bg-indigo-500/10 px-3 py-1 text-[13px] font-medium text-indigo-200">
            SEO · Answer engines · Generative AI
          </p>
          <h1 className="mx-auto mt-6 max-w-4xl text-4xl font-semibold tracking-tight text-balance text-white sm:text-6xl">
            Be found in search results{' '}
            <span className="bg-gradient-to-r from-indigo-300 to-sky-300 bg-clip-text text-transparent">
              and in AI answers
            </span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-pretty text-slate-300">
            Surfaced audits your website, helps you write content that answers real questions, and tracks how
            AI assistants mention and cite your brand. Every metric traces back to the pages and answers
            behind it.
          </p>
          <div className="mt-10 flex justify-center">
            <FreeAuditForm />
          </div>
          <p className="mt-2 text-sm text-slate-400">
            Prefer to look around first?{' '}
            <Link to="/how-it-works" className="font-medium text-indigo-300 hover:text-indigo-200">
              See how it works
            </Link>
          </p>
        </div>
        <div className="relative px-4 pb-20 sm:px-6 lg:px-8">
          <DashboardPreview />
        </div>
      </section>

      {/* How it works */}
      <Section id="how-it-works" className="border-t border-white/5">
        <SectionHeading
          eyebrow="How it works"
          title="Audit → Improve → Measure"
          text="A loop you can run every week, with the evidence for each step kept alongside the result."
        />
        <ol className="mt-12 grid gap-5 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-2xl border border-border bg-card p-6">
              <span className="flex size-9 items-center justify-center rounded-full bg-primary/15 text-sm font-semibold text-indigo-200">
                {index + 1}
              </span>
              <h3 className="mt-4 text-lg font-semibold text-white">{step.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-slate-300">{step.text}</p>
            </li>
          ))}
        </ol>
      </Section>

      {/* SEO / AEO / GEO */}
      <Section>
        <SectionHeading
          eyebrow="One workspace"
          title="SEO, AEO and GEO, measured together"
          text="The same fundamentals help you rank, get quoted and get cited. Surfaced checks all three from one project."
        />
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {PILLARS.map(({ key, label, title, icon: Icon, text }) => (
            <article key={key} className="rounded-2xl border border-border bg-card p-6">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className="text-sm font-semibold tracking-wide text-indigo-300">{label}</span>
              </div>
              <h3 className="mt-4 text-lg font-semibold text-white">{title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-slate-300">{text}</p>
            </article>
          ))}
        </div>
      </Section>

      {/* AI visibility */}
      <Section className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <SectionHeading
            align="left"
            eyebrow="AI visibility"
            title="Know when AI assistants recommend you, and when they don't"
          />
          <p className="mt-4 text-[17px] leading-relaxed text-slate-300">
            Add the prompts your customers ask, choose countries and languages, and Surfaced asks AI providers
            through their official APIs. Every answer is stored with its citations, so you can check exactly
            why a metric moved.
          </p>
          <ul className="mt-6 space-y-3 text-[15px] text-slate-300">
            {[
              'Mention rate, citation rate and share of voice, with published formulas',
              'Sample sizes shown on every metric; failed calls kept separate',
              'Competitor comparison and the sources each brand is cited from',
              'Sentiment labeled as an AI estimate, never as a measurement',
            ].map((t) => (
              <li key={t} className="flex gap-3">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-indigo-300" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
          <Link
            to="/features/ai-visibility"
            className="mt-8 inline-flex items-center gap-1.5 text-[15px] font-medium text-indigo-300 hover:text-indigo-200"
          >
            Learn about AI visibility tracking <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
        <div className="rounded-2xl border border-border bg-card p-5" aria-hidden>
          <div className="flex items-center gap-2 text-[13px] text-slate-400">
            <Radar className="size-4 text-indigo-300" /> Observation · OpenAI with web search · US · English
          </div>
          <p className="mt-4 rounded-lg bg-muted p-4 text-[13px] leading-relaxed text-slate-300">
            “For lightweight two-person tents, people often compare{' '}
            <mark className="rounded bg-indigo-500/25 px-1 text-indigo-100">Your Brand</mark>, Brand B and
            Brand C…”
          </p>
          <div className="mt-4 grid grid-cols-3 gap-3 text-center text-[12px]">
            {[
              ['Mentioned', 'Yes · rank 1'],
              ['Cited', '2 owned URLs'],
              ['Competitors', '2 mentioned'],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-border p-3">
                <p className="text-slate-400">{k}</p>
                <p className="mt-1 font-medium text-white">{v}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 text-center text-[12px] text-slate-500">Illustration with sample values</p>
        </div>
      </Section>

      {/* Content automation */}
      <Section className="grid items-center gap-12 lg:grid-cols-2">
        <div className="order-2 rounded-2xl border border-border bg-card p-5 lg:order-1" aria-hidden>
          <div className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 text-slate-300">
              <FileText className="size-4 text-indigo-300" /> How to choose a backpacking tent
            </span>
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-200">
              In review
            </span>
          </div>
          <div className="mt-4 space-y-2.5">
            <div className="h-3 w-3/4 rounded bg-white/10" />
            <div className="h-3 w-full rounded bg-white/5" />
            <div className="h-3 w-5/6 rounded bg-white/5" />
            <p className="rounded-md border border-dashed border-amber-400/40 px-2.5 py-1.5 text-[12px] text-amber-200">
              [SOURCE NEEDED: average tent weight by capacity]
            </p>
            <div className="h-3 w-2/3 rounded bg-white/5" />
          </div>
          <div className="mt-5 flex gap-2 text-[11px] text-slate-400">
            <span className="rounded border border-border px-2 py-1">v4 · saved 2 min ago</span>
            <span className="rounded border border-border px-2 py-1">3 internal links suggested</span>
          </div>
          <p className="mt-4 text-center text-[12px] text-slate-500">Illustration</p>
        </div>
        <div className="order-1 lg:order-2">
          <SectionHeading
            align="left"
            eyebrow="Content Studio"
            title="Drafts that answer questions, reviewed before they ship"
          />
          <p className="mt-4 text-[17px] leading-relaxed text-slate-300">
            Turn a brief into an outline, a full draft, meta tags, an FAQ or structured data. Drafts never
            invent sources. They mark claims that need evidence, suggest internal links from your real crawl,
            and move through review and approval. Nothing is published automatically.
          </p>
          <Link
            to="/features/content-studio"
            className="mt-8 inline-flex items-center gap-1.5 text-[15px] font-medium text-indigo-300 hover:text-indigo-200"
          >
            Explore Content Studio <ArrowRight className="size-4" aria-hidden />
          </Link>
        </div>
      </Section>

      {/* Use cases */}
      <Section className="border-t border-white/5">
        <SectionHeading eyebrow="Who it's for" title="Built for teams that need answers they can defend" />
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          {USE_CASES.map(({ icon: Icon, title, text }) => (
            <article key={title} className="rounded-2xl border border-border bg-card p-6">
              <Icon className="size-6 text-indigo-300" aria-hidden />
              <h3 className="mt-4 text-lg font-semibold text-white">{title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-slate-300">{text}</p>
            </article>
          ))}
        </div>
        <div className="mx-auto mt-10 flex max-w-3xl items-start gap-3 rounded-xl border border-border bg-card/60 p-4 text-sm text-slate-300">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-300" aria-hidden />
          <p>
            Our crawler respects robots.txt and never logs in, bypasses paywalls or reaches private networks.
            AI visibility uses official provider APIs only. Keyword volumes are shown only from a licensed
            data provider, never estimated.
          </p>
        </div>
      </Section>

      {/* Pricing preview */}
      <Section id="pricing">
        <SectionHeading
          eyebrow="Pricing"
          title="Start free, upgrade when you need more"
          text="Every plan includes the audit engine, AI visibility tracking and Content Studio. Limits grow with the plan."
        />
        <div className="mt-10">
          <PricingCards compact />
        </div>
        <p className="mt-6 text-center text-sm text-slate-400">
          <Link to="/pricing" className="font-medium text-indigo-300 hover:text-indigo-200">
            Compare all plan limits →
          </Link>
        </p>
      </Section>

      {/* FAQ */}
      <Section className="max-w-3xl">
        <SectionHeading eyebrow="FAQ" title="Questions people ask" />
        <Accordion type="single" collapsible className="mt-10">
          {HOME_FAQ.map((item) => (
            <AccordionItem key={item.q} value={item.q}>
              <AccordionTrigger className="text-white">{item.q}</AccordionTrigger>
              <AccordionContent className="text-slate-300">{item.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Section>

      <CtaBand />
    </>
  );
}
