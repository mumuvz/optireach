// Marketing copy in one place. Claims here describe what the product actually does; there are no
// customer logos, testimonials or performance statistics (none exist yet).
import { Bot, FileText, LineChart, Radar, ScanSearch, Swords, type LucideIcon } from 'lucide-react';

export interface NavLinkItem {
  label: string;
  to: string;
  description?: string;
}

export const FEATURE_LINKS: (NavLinkItem & { icon: LucideIcon })[] = [
  {
    label: 'SEO audit',
    to: '/features/seo-audit',
    description: 'Crawl your site and find technical issues',
    icon: ScanSearch,
  },
  {
    label: 'AI visibility',
    to: '/features/ai-visibility',
    description: 'Track mentions and citations in AI answers',
    icon: Radar,
  },
  {
    label: 'Content Studio',
    to: '/features/content-studio',
    description: 'Draft answer-ready content with review',
    icon: FileText,
  },
  {
    label: 'Competitor analysis',
    to: '/features/competitor-analysis',
    description: 'Compare visibility and sources',
    icon: Swords,
  },
];

export const MAIN_NAV: NavLinkItem[] = [
  { label: 'Features', to: '/features' },
  { label: 'How it works', to: '/how-it-works' },
  { label: 'Pricing', to: '/pricing' },
  { label: 'Resources', to: '/resources' },
  { label: 'Blog', to: '/blog' },
];

export const FOOTER_COLUMNS: { title: string; links: NavLinkItem[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Features', to: '/features' },
      ...FEATURE_LINKS.map(({ label, to }) => ({ label, to })),
      { label: 'Pricing', to: '/pricing' },
      { label: 'Free site audit', to: '/free-audit' },
    ],
  },
  {
    title: 'Learn',
    links: [
      { label: 'How it works', to: '/how-it-works' },
      { label: 'Resources', to: '/resources' },
      { label: 'Blog', to: '/blog' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', to: '/about' },
      { label: 'Contact', to: '/contact' },
      { label: 'Privacy policy', to: '/privacy' },
      { label: 'Terms of service', to: '/terms' },
    ],
  },
];

export const PILLARS = [
  {
    key: 'seo',
    label: 'SEO',
    title: 'Search engine optimization',
    icon: ScanSearch,
    text: 'Find what stops search engines from crawling, understanding and ranking your pages: broken links, missing metadata, redirect chains, slow responses, duplicate content and more.',
  },
  {
    key: 'aeo',
    label: 'AEO',
    title: 'Answer engine optimization',
    icon: Bot,
    text: 'Structure content so it directly answers the questions people ask: clear headings, concise answers, FAQs and valid structured data.',
  },
  {
    key: 'geo',
    label: 'GEO',
    title: 'Generative engine optimization',
    icon: LineChart,
    text: 'Measure whether AI assistants mention and cite your brand for the prompts that matter to you, and which sources they rely on instead.',
  },
] as const;

export const STEPS = [
  {
    title: 'Audit',
    text: 'Crawl your website within safe limits, respecting robots.txt. Every issue is stored with evidence, severity and a suggested fix, and tracked from first to last detection.',
  },
  {
    title: 'Improve',
    text: 'Work through prioritized recommendations, draft answer-ready content in Content Studio and send it through review. Nothing is published to your site automatically.',
  },
  {
    title: 'Measure',
    text: 'Re-run audits and AI visibility checks on a schedule. Metrics are calculated from stored observations, so every number can be traced back to the answers behind it.',
  },
] as const;

export const HOME_FAQ = [
  {
    q: 'What is the difference between SEO, AEO and GEO?',
    a: 'SEO improves how search engines crawl, index and rank your pages. AEO (answer engine optimization) makes your content easy to quote as a direct answer. GEO (generative engine optimization) is about how AI assistants describe and cite your brand. They overlap: a crawlable, well-structured site with clear answers helps all three.',
  },
  {
    q: 'Which AI assistants can you track?',
    a: 'Out of the box, OpenAI models with web search and model-only answers, through the official API. Perplexity is supported when an API key is configured. We only use official APIs. Assistants without one are not tracked, and we never scrape consumer chat interfaces.',
  },
  {
    q: 'How is the site health score calculated?',
    a: 'It is a diagnostic index from 0 to 100, calculated by Surfaced from the pages we crawl. Each audit category has a published weight and each issue severity a fixed penalty. It is not a Google ranking score, and improving it does not guarantee rankings.',
  },
  {
    q: 'Do you publish changes to my website?',
    a: 'No. Surfaced proposes fixes and drafts content. You review, approve and publish changes yourself. Content goes through a draft → review → approved workflow, and exports are available as Markdown or HTML.',
  },
  {
    q: 'Do you show keyword search volumes?',
    a: 'Only when a licensed keyword data provider is connected. We never estimate or invent search volume, difficulty or CPC. AI-generated keyword ideas are clearly labeled as unmeasured.',
  },
  {
    q: 'Is there a free plan?',
    a: 'Yes. The Free plan includes one project, small audits and a limited number of AI visibility checks each month. You can also run a one-off free audit of up to 20 pages without an account.',
  },
] as const;

export const FEATURE_PAGES = {
  'seo-audit': {
    path: '/features/seo-audit',
    eyebrow: 'SEO audit',
    title: 'A technical SEO audit you can verify',
    description:
      'Crawl your website safely, detect technical issues with deterministic rules, and track each issue from first detection to resolution.',
    seoTitle: 'Technical SEO audit and website crawler',
    seoDescription:
      'Crawl your site within safe limits, detect 55 technical SEO issues with evidence and fixes, and track every issue over time.',
    sections: [
      {
        title: 'A crawler that plays by the rules',
        text: 'Surfaced reads robots.txt and your XML sitemaps, follows internal links breadth-first, and records status codes, redirects, canonicals, metadata, headings, images, structured data and response times. It never logs in, bypasses paywalls or crawls private network addresses.',
        bullets: [
          'robots.txt and crawl-delay respected',
          'Sitemap index and gzip support',
          'Orphan pages found from sitemaps',
          'Configurable page and depth limits',
        ],
      },
      {
        title: 'Deterministic, explainable issues',
        text: 'Each of the 55 checks is a fixed rule with a severity, the evidence found on the page, why it matters and how to fix it. Re-running the same crawl gives the same result.',
        bullets: [
          'Broken links and 4xx/5xx pages',
          'Missing or duplicate titles and descriptions',
          'Redirect chains and canonical conflicts',
          'Thin and near-duplicate content',
        ],
      },
      {
        title: 'Issues with a history',
        text: 'Issues keep their identity across audits, so you can see when a problem first appeared, whether it is still present and when it was resolved. Ignore what does not apply, and reopen it later if needed.',
        bullets: [
          'First and last detection dates',
          'Automatic resolution only for re-crawled pages',
          'Page-level detail with inlinks and outlinks',
          'Scheduled weekly or monthly audits',
        ],
      },
    ],
  },
  'ai-visibility': {
    path: '/features/ai-visibility',
    eyebrow: 'AI visibility',
    title: 'See how AI assistants talk about your brand',
    description:
      'Track the prompts your customers ask. For every answer we record whether your brand is mentioned, which sources are cited and which competitors appear.',
    seoTitle: 'AI visibility tracking for brands',
    seoDescription:
      'Measure brand mentions, citations and share of voice in AI answers, using official provider APIs and stored, inspectable observations.',
    sections: [
      {
        title: 'Real answers, stored and inspectable',
        text: 'Each check calls an official provider API with your prompt, country and language, then stores the full answer, the cited URLs and the model used. You can open any observation and read exactly what was returned.',
        bullets: [
          'OpenAI with web search or model knowledge',
          'Perplexity when an API key is configured',
          'Country and language per prompt',
          'Failed calls are shown as failures, never hidden',
        ],
      },
      {
        title: 'Metrics with published formulas',
        text: 'Mention rate is the share of successful answers that mention your brand. Citation rate is the share that cite a page on your domain. Share of voice compares your mentions with your competitors’. Every chart shows how many observations it is based on.',
        bullets: [
          'Mention rate and citation rate',
          'Share of voice against competitors',
          'Most cited domains and sample URLs',
          'Trends by day, week or month',
        ],
      },
      {
        title: 'Honest about uncertainty',
        text: 'AI answers vary between runs. We show sample sizes, label sentiment as an AI estimate, and clearly mark demo data. Visibility metrics describe the answers we observed, not every answer a provider gives.',
        bullets: [
          'Sample size on every metric',
          'Sentiment labeled as an estimate',
          'Demo data clearly marked',
          'No scraping of consumer chat apps',
        ],
      },
    ],
  },
  'content-studio': {
    path: '/features/content-studio',
    eyebrow: 'Content Studio',
    title: 'Draft answer-ready content, then review it',
    description:
      'Turn briefs into outlines, articles, meta tags, FAQs and structured data. Drafts are versioned and go through an approval workflow before anyone publishes them.',
    seoTitle: 'AI content studio with approval workflow',
    seoDescription:
      'Create briefs, outlines and drafts with AI, add internal links from real crawl data, and approve content before publishing.',
    sections: [
      {
        title: 'From brief to draft',
        text: 'Start from a brief with a target keyword, audience and questions to answer. Generate an outline, a full draft, meta tags or an FAQ, or regenerate one section at a time.',
        bullets: [
          'Outlines, articles, meta tags and FAQs',
          'Section-by-section regeneration',
          'Brand voice from your project profile',
          'JSON-LD suggestions for FAQ and Article',
        ],
      },
      {
        title: 'No invented facts',
        text: 'Generation prompts forbid invented statistics, quotes and sources. Where a claim needs evidence, the draft inserts a visible "source needed" marker for your editor to resolve.',
        bullets: [
          '"Source needed" markers',
          'Internal link suggestions from your crawl only',
          'Raw HTML in drafts is escaped',
          'Development output clearly labeled',
        ],
      },
      {
        title: 'Review before anything ships',
        text: 'Every save creates a version you can compare and restore. Drafts move through draft, in review, approved and published, and only owners and admins can approve.',
        bullets: [
          'Version history and restore',
          'Role-based approval',
          'Markdown and HTML export',
          'Nothing is published automatically',
        ],
      },
    ],
  },
  'competitor-analysis': {
    path: '/features/competitor-analysis',
    eyebrow: 'Competitor analysis',
    title: 'Understand where competitors show up instead of you',
    description:
      'Compare AI mention and citation rates with your competitors, find prompts where they appear and you do not, and see which sources each of you is cited from.',
    seoTitle: 'Competitor visibility analysis',
    seoDescription:
      'Compare AI visibility with competitors, find topic gaps, and review shared and competitor-only cited sources.',
    sections: [
      {
        title: 'Side-by-side visibility',
        text: 'For the same set of prompts, see mention rate, citation rate, average position in the answer and share of voice for your brand and each competitor.',
        bullets: [
          'Mention and citation rates per entity',
          'Average rank within answers',
          'Trends over time',
          'Same observations, same formulas',
        ],
      },
      {
        title: 'Topic gaps and sources',
        text: 'Find prompts where competitors are mentioned and you are not, and the domains that cite them. Those are often the pages and publications worth earning a place in.',
        bullets: [
          'Prompts where only competitors appear',
          'Shared vs competitor-only sources',
          'Sample answers for every gap',
          'Export-ready tables',
        ],
      },
      {
        title: 'Public metadata only',
        text: 'Competitor snapshots read a few public pages (titles, descriptions, headings, structured data) and respect robots.txt. We never log in, bypass access controls or collect private data.',
        bullets: [
          'robots.txt respected',
          'Small, polite page budget',
          'Side-by-side metadata comparison',
          'No private or gated content',
        ],
      },
    ],
  },
} as const;

export type FeatureKey = keyof typeof FEATURE_PAGES;
