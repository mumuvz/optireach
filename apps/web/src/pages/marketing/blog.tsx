import { renderMarkdown } from '@surfaced/shared/markdown';
import { ArrowLeft, Clock } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { CtaBand } from '@/components/marketing/blocks';
import { Section } from '@/components/marketing/layout';
import {
  BLOG_CATEGORIES,
  BLOG_POSTS,
  findPost,
  relatedPosts,
  type BlogCategory,
  type BlogPost,
} from '@/content/blog';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { Seo } from '@/lib/seo';
import { articleLd, breadcrumbLd } from '@/lib/structured-data';
import { NotFoundPage } from './simple-pages';

function PostCard({ post }: { post: BlogPost }) {
  return (
    <article className="flex flex-col rounded-2xl border border-border bg-card p-6 transition-colors hover:border-indigo-400/40">
      <p className="text-xs font-semibold tracking-wide text-indigo-300 uppercase">
        {BLOG_CATEGORIES[post.category].label} · {post.cluster}
      </p>
      <h2 className="mt-3 text-lg leading-snug font-semibold text-white">
        <Link to={`/blog/${post.slug}`} className="hover:text-indigo-200">
          {post.title}
        </Link>
      </h2>
      <p className="mt-2 flex-1 text-[15px] leading-relaxed text-slate-300">{post.description}</p>
      <p className="mt-5 flex items-center gap-3 text-[13px] text-slate-400">
        <time dateTime={post.publishedAt}>{formatDate(post.publishedAt)}</time>
        <span className="flex items-center gap-1">
          <Clock className="size-3.5" aria-hidden /> {post.readingMinutes} min read
        </span>
      </p>
      <Link
        to={`/blog/${post.slug}`}
        className="mt-4 text-sm font-medium text-indigo-300 hover:text-indigo-200"
        aria-label={`Read: ${post.title}`}
      >
        Read article →
      </Link>
    </article>
  );
}

/** /blog and /blog/category/:category (each category is its own prerendered page). */
export function BlogIndexPage() {
  const { category: raw } = useParams();
  const category = raw && raw in BLOG_CATEGORIES ? (raw as BlogCategory) : null;
  if (raw && !category) return <NotFoundPage />;
  const posts = category ? BLOG_POSTS.filter((p) => p.category === category) : BLOG_POSTS;
  const path = category ? `/blog/category/${category}` : '/blog';
  return (
    <>
      <Seo
        title={category ? `${BLOG_CATEGORIES[category].label} articles` : 'Blog: SEO, AEO and GEO guides'}
        description={
          category
            ? `${BLOG_CATEGORIES[category].label} guides from the Surfaced blog: ${BLOG_CATEGORIES[category].description.toLowerCase()}`
            : 'Practical guides to technical SEO, answer engine optimization and measuring brand visibility in AI answers.'
        }
        path={path}
        jsonLd={breadcrumbLd([
          { name: 'Home', path: '/' },
          { name: 'Blog', path: '/blog' },
          ...(category ? [{ name: BLOG_CATEGORIES[category].label, path }] : []),
        ])}
      />
      <Section className="pb-8">
        <p className="text-sm font-semibold tracking-wide text-indigo-300 uppercase">Blog</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
          Guides to search and AI visibility
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-slate-300">
          Clear explanations, practical checklists and the exact definitions behind our metrics.
        </p>
        <nav aria-label="Categories" className="mt-8 flex flex-wrap gap-2">
          {[
            { key: null, label: 'All articles' },
            ...Object.entries(BLOG_CATEGORIES).map(([key, c]) => ({ key, label: c.label })),
          ].map((c) => (
            <Link
              key={c.label}
              to={c.key ? `/blog/category/${c.key}` : '/blog'}
              aria-current={category === c.key ? 'page' : undefined}
              className={cn(
                'rounded-full border px-4 py-1.5 text-sm font-medium transition-colors',
                category === c.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-slate-300 hover:text-white',
              )}
            >
              {c.label}
            </Link>
          ))}
        </nav>
        {category ? (
          <p className="mt-4 text-sm text-slate-400">{BLOG_CATEGORIES[category].description}</p>
        ) : null}
      </Section>
      <Section className="pt-0">
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {posts.map((post) => (
            <PostCard key={post.slug} post={post} />
          ))}
        </div>
      </Section>
    </>
  );
}

export function BlogPostPage() {
  const { slug } = useParams();
  const post = findPost(slug);
  if (!post) return <NotFoundPage />;
  const related = relatedPosts(post);
  return (
    <>
      <Seo
        title={post.title}
        description={post.description}
        path={`/blog/${post.slug}`}
        ogType="article"
        publishedTime={post.publishedAt}
        jsonLd={[
          articleLd(post),
          breadcrumbLd([
            { name: 'Home', path: '/' },
            { name: 'Blog', path: '/blog' },
            { name: post.title, path: `/blog/${post.slug}` },
          ]),
        ]}
      />
      <article className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
        <Link to="/blog" className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white">
          <ArrowLeft className="size-4" aria-hidden /> All articles
        </Link>
        <header className="mt-6">
          <p className="text-xs font-semibold tracking-wide text-indigo-300 uppercase">
            <Link to={`/blog/category/${post.category}`} className="hover:text-indigo-200">
              {BLOG_CATEGORIES[post.category].label}
            </Link>{' '}
            · {post.cluster}
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-balance text-white sm:text-[2.6rem] sm:leading-tight">
            {post.title}
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-slate-300">{post.description}</p>
          <p className="mt-5 flex flex-wrap items-center gap-3 text-sm text-slate-400">
            <span>By the Surfaced team</span>
            <span aria-hidden>·</span>
            <time dateTime={post.publishedAt}>{formatDate(post.publishedAt, { dateStyle: 'long' })}</time>
            <span aria-hidden>·</span>
            <span>{post.readingMinutes} min read</span>
          </p>
        </header>
        <div
          className="prose-content mt-10 text-slate-200 [&_h2]:text-white [&_h3]:text-white"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(post.body) }}
        />
      </article>
      {related.length ? (
        <Section className="border-t border-white/5">
          <h2 className="text-xl font-semibold text-white">Related articles</h2>
          <div className="mt-6 grid gap-5 md:grid-cols-3">
            {related.map((p) => (
              <PostCard key={p.slug} post={p} />
            ))}
          </div>
        </Section>
      ) : null}
      <CtaBand />
    </>
  );
}
