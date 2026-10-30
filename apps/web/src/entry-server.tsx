// Server entry used only at build time by scripts/prerender.ts.
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router';
import { App } from './App';
import { createQueryClient } from './lib/query';
import { HeadContext, renderHeadTags, type HeadCollector, type SeoData } from './lib/seo';

export { publicRoutes } from './routes/public-routes';
export { SITE_URL } from './lib/config';

export function render(url: string): { html: string; head: string; seo: SeoData | null } {
  const collector: HeadCollector = { data: null };
  const html = renderToString(
    <StrictMode>
      <HeadContext.Provider value={collector}>
        <QueryClientProvider client={createQueryClient()}>
          <StaticRouter location={url}>
            <App />
          </StaticRouter>
        </QueryClientProvider>
      </HeadContext.Provider>
    </StrictMode>,
  );
  return { html, head: collector.data ? renderHeadTags(collector.data) : '', seo: collector.data };
}
