// JSON-LD for the marketing site. Every block describes facts that are visible on the page:
// no ratings, reviews or claims that are not shown to readers.
import { DEFAULT_PLANS } from '@surfaced/shared';
import { APP_NAME, CONTACT_EMAIL, SITE_URL, absoluteUrl } from './config';

type Ld = Record<string, unknown>;

export function organizationLd(): Ld {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${SITE_URL}/#organization`,
    name: APP_NAME,
    url: `${SITE_URL}/`,
    logo: absoluteUrl('/logo-512.png'),
    email: CONTACT_EMAIL,
  };
}

export function websiteLd(): Ld {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${SITE_URL}/#website`,
    name: APP_NAME,
    url: `${SITE_URL}/`,
    publisher: { '@id': `${SITE_URL}/#organization` },
  };
}

export function softwareApplicationLd(): Ld {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: APP_NAME,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web browser',
    url: `${SITE_URL}/`,
    description:
      'SEO auditing, answer engine optimization and AI visibility tracking for websites and brands.',
    publisher: { '@id': `${SITE_URL}/#organization` },
    offers: DEFAULT_PLANS.map((plan) => ({
      '@type': 'Offer',
      name: plan.name,
      price: plan.priceMonthly.toFixed(2),
      priceCurrency: plan.currency,
      url: absoluteUrl('/pricing'),
    })),
  };
}

export function faqLd(items: readonly { q: string; a: string }[]): Ld {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

export function articleLd(post: {
  slug: string;
  title: string;
  description: string;
  publishedAt: string;
  updatedAt?: string;
}): Ld {
  return {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt ?? post.publishedAt,
    mainEntityOfPage: absoluteUrl(`/blog/${post.slug}`),
    author: { '@type': 'Organization', name: `${APP_NAME} team`, url: `${SITE_URL}/about` },
    publisher: { '@id': `${SITE_URL}/#organization` },
    image: absoluteUrl('/og-image.png'),
  };
}

export function breadcrumbLd(items: { name: string; path: string }[]): Ld {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}
