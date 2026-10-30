import { ArrowRight, BookOpen, Compass, ListChecks, ScanSearch } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { CtaBand } from '@/components/marketing/blocks';
import { Section } from '@/components/marketing/layout';
import { Button } from '@/components/ui/button';
import { blogClusters } from '@/content/blog';
import { APP_NAME, CONTACT_EMAIL } from '@/lib/config';
import { Seo } from '@/lib/seo';
import { breadcrumbLd, organizationLd } from '@/lib/structured-data';

function PageIntro({ eyebrow, title, text }: { eyebrow: string; title: string; text?: string }) {
  return (
    <Section className="pb-8">
      <p className="text-sm font-semibold tracking-wide text-indigo-300 uppercase">{eyebrow}</p>
      <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">{title}</h1>
      {text ? <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-300">{text}</p> : null}
    </Section>
  );
}

const PRINCIPLES = [
  {
    title: 'Every number has a source',
    text: 'Scores and metrics are calculated from stored crawl data and stored AI answers. You can open the pages and observations behind any figure.',
  },
  {
    title: 'No invented data',
    text: 'We do not estimate search volumes, fabricate citations or show sample data as real. Demo data is labeled, and estimates are marked as estimates.',
  },
  {
    title: 'Respect for the web',
    text: 'Our crawler follows robots.txt, uses small page budgets, and never logs in, bypasses paywalls or reaches private networks. AI providers are used through their official APIs.',
  },
  {
    title: 'People stay in control',
    text: 'Surfaced proposes fixes and drafts content. People review, approve and publish. Nothing is changed on your website automatically.',
  },
];

export function AboutPage() {
  return (
    <>
      <Seo
        title="About"
        description={`Why we built ${APP_NAME}: one place to improve search visibility, answer-readiness and AI visibility, with metrics you can verify.`}
        path="/about"
        jsonLd={[
          organizationLd(),
          breadcrumbLd([
            { name: 'Home', path: '/' },
            { name: 'About', path: '/about' },
          ]),
        ]}
      />
      <PageIntro
        eyebrow="About"
        title="Visibility you can verify"
        text={`Search is no longer only a list of links. People ask AI assistants for recommendations and expect a single answer. ${APP_NAME} helps teams understand and improve how they show up across search results, answer boxes and AI answers.`}
      />
      <Section className="max-w-4xl pt-0">
        <div className="prose-content text-slate-300 [&_h2]:text-white">
          <h2>Why we built it</h2>
          <p>
            Most visibility tools show a score without showing their working. When AI answers became a real
            channel, that problem got worse: numbers appeared with no way to check which answers they came
            from. We wanted a tool where the audit, the content work and AI visibility metrics live in one
            project and every result can be traced back to its evidence.
          </p>
          <h2>What we believe</h2>
        </div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {PRINCIPLES.map((p) => (
            <article key={p.title} className="rounded-2xl border border-border bg-card p-6">
              <h3 className="font-semibold text-white">{p.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-slate-300">{p.text}</p>
            </article>
          ))}
        </div>
        <p className="mt-10 text-[15px] text-slate-300">
          Questions, feedback or partnership ideas?{' '}
          <Link to="/contact" className="font-medium text-indigo-300 hover:text-indigo-200">
            Get in touch
          </Link>
          .
        </p>
      </Section>
      <CtaBand />
    </>
  );
}

const GLOSSARY = [
  ['SEO (search engine optimization)', 'Improving how search engines crawl, index and rank your pages.'],
  [
    'AEO (answer engine optimization)',
    'Structuring content so a clear answer can be quoted by featured snippets, voice assistants and AI tools.',
  ],
  [
    'GEO (generative engine optimization)',
    'Improving how generative AI assistants mention, describe and cite your brand.',
  ],
  [
    'Observation',
    'One prompt answered once by one AI provider for a given country and language, stored with its full answer and citations.',
  ],
  [
    'Mention rate',
    'Successful observations that mention your brand, divided by all successful observations.',
  ],
  [
    'Citation rate',
    'Successful observations that cite at least one URL on your domain, divided by all successful observations.',
  ],
  [
    'Share of voice',
    'Your brand’s mentions divided by the mentions of your brand plus all tracked competitors, counting each answer once per brand.',
  ],
  [
    'Site health index',
    'A 0–100 diagnostic summary of audit findings, weighted by category and severity. It is not a search engine ranking score.',
  ],
  ['Canonical URL', 'The URL you tell search engines to treat as the main version of a page.'],
  ['Orphan page', 'A page listed in your sitemap that no internal link points to.'],
  [
    'Structured data',
    'Machine-readable descriptions of a page (usually JSON-LD with schema.org types) that reduce ambiguity.',
  ],
  ['robots.txt', 'A file at the root of a site that tells crawlers which paths they may fetch (RFC 9309).'],
] as const;

export function ResourcesPage() {
  const clusters = blogClusters();
  return (
    <>
      <Seo
        title="Resources"
        description="Guides, checklists and a glossary for technical SEO, answer engine optimization and AI visibility measurement."
        path="/resources"
        jsonLd={breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Resources', path: '/resources' },
        ])}
      />
      <PageIntro
        eyebrow="Resources"
        title="Learn the fundamentals"
        text="Guides grouped by topic, a free audit tool and the definitions we use for every metric."
      />
      <Section className="pt-0">
        <div className="grid gap-5 md:grid-cols-3">
          {[
            {
              icon: ScanSearch,
              title: 'Free site audit',
              text: 'Check up to 20 pages of any public website for technical issues.',
              to: '/free-audit',
              cta: 'Run a free audit',
            },
            {
              icon: ListChecks,
              title: 'Technical SEO checklist',
              text: 'The checks that catch most crawlability and indexing problems.',
              to: '/blog/technical-seo-audit-checklist',
              cta: 'Read the checklist',
            },
            {
              icon: Compass,
              title: 'Metric definitions',
              text: 'Exactly how mention rate, citation rate and share of voice are calculated.',
              to: '/blog/mention-rate-citation-rate-share-of-voice',
              cta: 'Read the definitions',
            },
          ].map(({ icon: Icon, title, text, to, cta }) => (
            <Link
              key={to}
              to={to}
              className="group rounded-2xl border border-border bg-card p-6 transition-colors hover:border-indigo-400/40"
            >
              <Icon className="size-6 text-indigo-300" aria-hidden />
              <h2 className="mt-4 text-lg font-semibold text-white">{title}</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-slate-300">{text}</p>
              <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-indigo-300 group-hover:text-indigo-200">
                {cta} <ArrowRight className="size-4" aria-hidden />
              </span>
            </Link>
          ))}
        </div>
      </Section>
      <Section className="border-t border-white/5">
        <h2 className="text-2xl font-semibold tracking-tight text-white">Guides by topic</h2>
        <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-4">
          {clusters.map(({ cluster, posts }) => (
            <section key={cluster} className="rounded-2xl border border-border bg-card p-6">
              <h3 className="flex items-center gap-2 font-semibold text-white">
                <BookOpen className="size-4 text-indigo-300" aria-hidden /> {cluster}
              </h3>
              <ul className="mt-4 space-y-2.5">
                {posts.map((post) => (
                  <li key={post.slug}>
                    <Link
                      to={`/blog/${post.slug}`}
                      className="text-[15px] leading-snug text-slate-300 hover:text-white"
                    >
                      {post.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Section>
      <Section className="max-w-4xl border-t border-white/5">
        <h2 className="text-2xl font-semibold tracking-tight text-white">Glossary</h2>
        <dl className="mt-8 divide-y divide-border rounded-2xl border border-border bg-card">
          {GLOSSARY.map(([term, definition]) => (
            <div key={term} className="grid gap-1 p-5 sm:grid-cols-[16rem_1fr] sm:gap-6">
              <dt className="font-medium text-white">{term}</dt>
              <dd className="text-[15px] leading-relaxed text-slate-300">{definition}</dd>
            </div>
          ))}
        </dl>
      </Section>
      <CtaBand />
    </>
  );
}

const UPDATED = 'October 22, 2026';

function LegalPage({
  title,
  path,
  description,
  children,
}: {
  title: string;
  path: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <>
      <Seo title={title} description={description} path={path} />
      <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
        <h1 className="text-4xl font-semibold tracking-tight text-white">{title}</h1>
        <p className="mt-3 text-sm text-slate-400">Last updated: {UPDATED}</p>
        <div className="prose-content mt-10 text-slate-300 [&_h2]:text-white">{children}</div>
      </article>
    </>
  );
}

export function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy policy"
      path="/privacy"
      description={`How ${APP_NAME} collects, uses and protects personal data.`}
    >
      <p>
        This policy explains what personal data {APP_NAME} processes when you visit our website or use the
        application, why we process it, and the choices you have.
      </p>
      <h2>Data we collect</h2>
      <ul>
        <li>
          <strong>Account data:</strong> your name, email address and a password hash (we never store your
          password in readable form), plus your notification preferences.
        </li>
        <li>
          <strong>Workspace and project data:</strong> the websites, competitors, keywords, prompts, content
          and settings you add, and the results we generate for them.
        </li>
        <li>
          <strong>Crawl data:</strong> publicly accessible pages of the websites you ask us to audit,
          including metadata, links and response details.
        </li>
        <li>
          <strong>Security data:</strong> the IP address and browser of each sign-in session, an audit log of
          important account actions (with the IP address), and short-lived rate-limit counters. Free audits
          and contact messages store only a hashed IP address.
        </li>
        <li>
          <strong>Messages:</strong> what you send us through the contact form.
        </li>
      </ul>
      <h2>How we use it</h2>
      <p>
        We use this data to provide the service, secure accounts, send transactional emails (verification,
        password reset, invitations, reports and billing notices), enforce plan limits, and answer your
        questions. We do not sell personal data and we do not use advertising trackers.
      </p>
      <h2>Service providers</h2>
      <ul>
        <li>
          <strong>AI providers</strong> (such as OpenAI and, when enabled, Perplexity) receive the prompts and
          content inputs needed to produce AI visibility observations and content drafts.
        </li>
        <li>
          <strong>Payment providers</strong> (Stripe or Razorpay) process payments. We never receive or store
          full card details.
        </li>
        <li>
          <strong>Google</strong>, if you connect Search Console, provides the performance data you authorize.
          OAuth tokens are encrypted at rest, and you can disconnect at any time.
        </li>
        <li>
          <strong>Email delivery and hosting providers</strong> process data on our behalf to run the service.
        </li>
      </ul>
      <h2>Cookies</h2>
      <p>
        We use strictly necessary cookies only: an HTTP-only session cookie that keeps you signed in, and a
        security token cookie that protects forms against cross-site request forgery. We do not use analytics
        or advertising cookies.
      </p>
      <h2>Retention</h2>
      <p>
        Free audit results expire after 7 days. Account data is kept while your account is active. When you
        request account deletion, there is a 14-day grace period in which you can cancel the request; after
        that, your account data is deleted, except where we must keep records for legal or accounting reasons.
      </p>
      <h2>Your rights</h2>
      <p>
        Depending on where you live, you may have the right to access, correct, export or delete your personal
        data, and to object to or restrict certain processing. You can update your profile and request
        deletion in the application settings, or contact us at{' '}
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
      <h2>Security</h2>
      <p>
        We protect data with encrypted connections, hashed passwords, encrypted third-party tokens, role-based
        access and strict separation between workspaces. No system is perfectly secure, but we work to protect
        your data and will notify you of breaches as required by law.
      </p>
      <h2>Changes</h2>
      <p>
        If we change this policy, we will update the date above and, for significant changes, notify account
        owners by email.
      </p>
    </LegalPage>
  );
}

export function TermsPage() {
  return (
    <LegalPage
      title="Terms of service"
      path="/terms"
      description={`The terms that apply when you use ${APP_NAME}.`}
    >
      <p>
        These terms apply to your use of {APP_NAME}. By creating an account or using the service, you agree to
        them. If you use the service on behalf of an organization, you confirm that you may accept these terms
        for it.
      </p>
      <h2>Your account</h2>
      <p>
        Keep your login details secure and tell us about any unauthorized use. Workspace owners control who
        has access to their workspace and are responsible for the roles they assign.
      </p>
      <h2>Acceptable use</h2>
      <ul>
        <li>Only ask us to crawl publicly accessible websites, and use the results lawfully.</li>
        <li>
          Do not use the service to overload, attack or gain unauthorized access to any system, or to collect
          personal data from other websites.
        </li>
        <li>Do not try to bypass plan limits, rate limits or security controls.</li>
        <li>Do not use AI features to create unlawful, deceptive or infringing content.</li>
      </ul>
      <p>
        Our crawler respects robots.txt and stays within small page budgets. We may suspend accounts that
        abuse the service.
      </p>
      <h2>Results and AI output</h2>
      <p>
        Audit scores, AI visibility metrics and recommendations are diagnostic information based on the data
        we collect. They do not guarantee search rankings, featured snippets or citations by AI assistants.
        AI-generated drafts can contain errors. Review all content before you publish it; you are responsible
        for what you publish.
      </p>
      <h2>Your content</h2>
      <p>
        You keep ownership of the content and data you add. You give us permission to process it only to
        provide the service. Third-party AI providers process inputs under their own terms.
      </p>
      <h2>Plans and billing</h2>
      <p>
        Paid plans renew automatically each billing period until cancelled. Cancellation takes effect at the
        end of the current period. Plan limits are described on the pricing page. Payments are processed by
        our payment providers, and unpaid subscriptions may be downgraded.
      </p>
      <h2>Availability and changes</h2>
      <p>
        We work to keep the service available but do not guarantee uninterrupted operation. Features that
        depend on third parties, such as AI providers or Google, may change or become unavailable. We may
        update these terms and will notify account owners of material changes.
      </p>
      <h2>Liability</h2>
      <p>
        To the extent permitted by law, the service is provided "as is", and our total liability for any claim
        is limited to the fees you paid in the twelve months before the claim. We are not liable for indirect
        or consequential losses.
      </p>
      <h2>Contact</h2>
      <p>
        Questions about these terms? Write to <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.
      </p>
    </LegalPage>
  );
}

export function NotFoundPage() {
  return (
    <>
      <Seo
        title="Page not found"
        description="The page you are looking for does not exist."
        path="/404"
        noindex
      />
      <Section className="flex min-h-[60vh] flex-col items-center justify-center text-center">
        <p className="text-sm font-semibold text-indigo-300">404</p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-white">Page not found</h1>
        <p className="mt-4 max-w-md text-slate-300">
          The page may have moved, or the address may be mistyped.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button asChild>
            <Link to="/">Go to the home page</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="border-white/15 bg-transparent text-white hover:bg-white/5"
          >
            <Link to="/blog">Read the blog</Link>
          </Button>
        </div>
      </Section>
    </>
  );
}
