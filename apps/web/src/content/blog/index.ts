import { AEO_GEO_POSTS } from './posts-aeo-geo';
import { SEO_POSTS } from './posts-seo';
import type { BlogCategory, BlogPost, BlogPostSource } from './types';

export type { BlogCategory, BlogPost } from './types';

export const BLOG_CATEGORIES: Record<BlogCategory, { label: string; description: string }> = {
  seo: { label: 'SEO', description: 'Crawlability, indexing, metadata and site structure.' },
  aeo: { label: 'AEO', description: 'Writing and structuring content so it can be quoted as an answer.' },
  geo: { label: 'GEO', description: 'Measuring and improving how AI assistants mention and cite brands.' },
};

function withReadingTime(post: BlogPostSource): BlogPost {
  const words = post.body.split(/\s+/).filter(Boolean).length;
  return { ...post, body: post.body.trim(), readingMinutes: Math.max(1, Math.round(words / 220)) };
}

export const BLOG_POSTS: BlogPost[] = [...SEO_POSTS, ...AEO_GEO_POSTS]
  .map(withReadingTime)
  .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

export function findPost(slug: string | undefined): BlogPost | undefined {
  return BLOG_POSTS.find((p) => p.slug === slug);
}

/** Same cluster first, then same category. */
export function relatedPosts(post: BlogPost, limit = 3): BlogPost[] {
  const others = BLOG_POSTS.filter((p) => p.slug !== post.slug);
  const score = (p: BlogPost) =>
    (p.cluster === post.cluster ? 2 : 0) + (p.category === post.category ? 1 : 0);
  return others
    .sort((a, b) => score(b) - score(a) || b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit);
}

export function blogClusters(): { cluster: string; posts: BlogPost[] }[] {
  const map = new Map<string, BlogPost[]>();
  for (const post of BLOG_POSTS) map.set(post.cluster, [...(map.get(post.cluster) ?? []), post]);
  return [...map.entries()].map(([cluster, posts]) => ({ cluster, posts }));
}
