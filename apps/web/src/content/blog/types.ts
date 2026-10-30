export type BlogCategory = 'seo' | 'aeo' | 'geo';

export interface BlogPostSource {
  slug: string;
  title: string;
  description: string;
  category: BlogCategory;
  /** Topic cluster used to group related articles. */
  cluster: string;
  /** ISO date (YYYY-MM-DD). */
  publishedAt: string;
  updatedAt?: string;
  /** Markdown body (rendered with the shared safe Markdown renderer). */
  body: string;
}

export interface BlogPost extends BlogPostSource {
  readingMinutes: number;
}
