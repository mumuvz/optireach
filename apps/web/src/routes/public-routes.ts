// Every public URL that is prerendered to static HTML. The sitemap includes the indexable ones.
import { BLOG_CATEGORIES, BLOG_POSTS } from '@/content/blog';
import { FEATURE_PAGES } from '@/content/site';

export interface PublicRoute {
  path: string;
  /** Listed in sitemap.xml (auth pages are prerendered but noindex). */
  sitemap: boolean;
  priority?: number;
  changefreq?: 'weekly' | 'monthly' | 'yearly';
  lastmod?: string;
}

export function publicRoutes(): PublicRoute[] {
  return [
    { path: '/', sitemap: true, priority: 1, changefreq: 'weekly' },
    { path: '/features', sitemap: true, priority: 0.9, changefreq: 'monthly' },
    ...Object.values(FEATURE_PAGES).map((f) => ({
      path: f.path,
      sitemap: true,
      priority: 0.8,
      changefreq: 'monthly' as const,
    })),
    { path: '/pricing', sitemap: true, priority: 0.9, changefreq: 'monthly' },
    { path: '/how-it-works', sitemap: true, priority: 0.7, changefreq: 'monthly' },
    { path: '/resources', sitemap: true, priority: 0.6, changefreq: 'monthly' },
    { path: '/blog', sitemap: true, priority: 0.7, changefreq: 'weekly' },
    ...Object.keys(BLOG_CATEGORIES).map((c) => ({
      path: `/blog/category/${c}`,
      sitemap: true,
      priority: 0.5,
      changefreq: 'weekly' as const,
    })),
    ...BLOG_POSTS.map((p) => ({
      path: `/blog/${p.slug}`,
      sitemap: true,
      priority: 0.6,
      changefreq: 'monthly' as const,
      lastmod: p.updatedAt ?? p.publishedAt,
    })),
    { path: '/about', sitemap: true, priority: 0.5, changefreq: 'yearly' },
    { path: '/contact', sitemap: true, priority: 0.5, changefreq: 'yearly' },
    { path: '/free-audit', sitemap: true, priority: 0.8, changefreq: 'monthly' },
    { path: '/privacy', sitemap: true, priority: 0.3, changefreq: 'yearly' },
    { path: '/terms', sitemap: true, priority: 0.3, changefreq: 'yearly' },
    { path: '/login', sitemap: false },
    { path: '/register', sitemap: false },
    { path: '/forgot-password', sitemap: false },
    { path: '/reset-password', sitemap: false },
  ];
}
