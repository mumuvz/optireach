import { CtaBand } from '@/components/marketing/blocks';
import { Section, SectionHeading } from '@/components/marketing/layout';
import { PlanComparisonTable, PricingCards, usePlans } from '@/components/marketing/pricing';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/tabs';
import { Seo } from '@/lib/seo';
import { breadcrumbLd, faqLd, softwareApplicationLd } from '@/lib/structured-data';

const PRICING_FAQ = [
  {
    q: 'What counts as an AI visibility check?',
    a: 'One check is one prompt answered by one provider. A prompt tracked with two providers uses two checks each time it runs. Failed calls are recorded, but usage is only counted for successful observations.',
  },
  {
    q: 'When do monthly limits reset?',
    a: 'On the first day of each calendar month in UTC. Project, team member and tracked prompt limits are totals, not monthly allowances.',
  },
  {
    q: 'Can I change or cancel my plan?',
    a: 'Yes. Upgrades take effect after payment is confirmed by the payment provider. Cancellations take effect at the end of the current billing period, and you keep access until then.',
  },
  {
    q: 'Do you offer keyword search volume data?',
    a: 'Search volume, difficulty and CPC are shown only when a licensed keyword data provider is connected. We do not estimate or invent these numbers.',
  },
  {
    q: 'Which payment methods do you accept?',
    a: 'Payments are processed by Stripe or Razorpay, depending on your region. We never see or store your card details.',
  },
] as const;

export default function PricingPage() {
  const { data } = usePlans();
  const devMode = data?.billing?.mode === 'development';
  return (
    <>
      <Seo
        title="Pricing"
        description="Simple plans for SEO audits, AI visibility tracking and content work. Start free, then upgrade for more projects, checks and team members."
        path="/pricing"
        jsonLd={[
          softwareApplicationLd(),
          faqLd(PRICING_FAQ),
          breadcrumbLd([
            { name: 'Home', path: '/' },
            { name: 'Pricing', path: '/pricing' },
          ]),
        ]}
      />
      <Section className="pb-10 text-center">
        <p className="text-sm font-semibold tracking-wide text-indigo-300 uppercase">Pricing</p>
        <h1 className="mx-auto mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Plans that grow with your website
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-slate-300">
          Every plan includes the audit engine, AI visibility tracking, Content Studio and reports. Pick the
          limits you need.
        </p>
        {devMode ? (
          <p
            className="mx-auto mt-6 max-w-xl rounded-lg border border-amber-400/30 bg-amber-500/10 px-4 py-2.5 text-sm text-amber-100"
            role="status"
          >
            This deployment runs in development billing mode: plan changes are simulated and no payment is
            taken.
          </p>
        ) : null}
      </Section>
      <Section className="pt-0">
        <PricingCards />
      </Section>
      <Section className="pt-0">
        <h2 className="mb-6 text-2xl font-semibold tracking-tight text-white">Compare plan limits</h2>
        <PlanComparisonTable />
        <p className="mt-4 text-[13px] text-slate-400">
          Prices are in the plan currency and exclude applicable taxes. Monthly limits reset on the first day
          of each month (UTC).
        </p>
      </Section>
      <Section className="max-w-3xl">
        <SectionHeading title="Pricing questions" />
        <Accordion type="single" collapsible className="mt-8">
          {PRICING_FAQ.map((item) => (
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
