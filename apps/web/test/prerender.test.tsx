// Renders public routes exactly as the build-time prerender does and checks the static HTML.
import { describe, expect, it } from 'vitest';
import { BLOG_POSTS } from '@/content/blog';
import { publicRoutes, render } from '@/entry-server';

describe('prerendered public pages', () => {
  it('renders the home page with its content, metadata and structured data', () => {
    const { html, head } = render('/');
    expect(html).toContain('Be found in search results');
    expect(html).toContain('Audit → Improve → Measure');
    // FAQ answers are in the HTML (collapsed, not missing), matching the FAQPage structured data.
    expect(html).toContain('It is not a Google ranking score');
    expect(head).toContain('<title>Surfaced — SEO, AEO and AI visibility platform</title>');
    expect(head).toContain('"@type":"FAQPage"');
    expect(head).toContain('"@type":"Organization"');
    expect(head).not.toContain('aggregateRating');
  });

  it('gives every public route its own title, description and canonical URL', () => {
    const titles = new Set<string>();
    for (const route of publicRoutes()) {
      const { head } = render(route.path);
      const title = /<title>([^<]+)<\/title>/.exec(head)?.[1];
      expect(title, route.path).toBeTruthy();
      expect(head, route.path).toMatch(/<meta name="description" content="[^"]{20,}"/);
      expect(head, route.path).toContain(`/${route.path === '/' ? '' : route.path.slice(1)}" data-seo>`);
      titles.add(title!);
      if (!route.sitemap) expect(head, route.path).toContain('noindex');
    }
    expect(titles.size).toBe(publicRoutes().length);
  });

  it('renders blog posts as articles with escaped Markdown', () => {
    const post = BLOG_POSTS[0]!;
    const { html, head } = render(`/blog/${post.slug}`);
    expect(html).toContain(post.title);
    expect(html).toContain('<h2');
    expect(head).toContain('"@type":"BlogPosting"');
    expect(head).toContain('property="og:type" content="article"');
  });

  it('renders the 404 page as noindex', () => {
    const { html, head } = render('/definitely-not-a-page');
    expect(html).toContain('Page not found');
    expect(head).toContain('noindex');
  });
});
