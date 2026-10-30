# Reference research

The brief asked for a study of these pages as inspiration for information architecture and polish:

| Page            | URL                                      |
| --------------- | ---------------------------------------- |
| Homepage        | https://aeoengine.ai/?ref=trustmrr       |
| Platform        | https://aeoengine.ai/platform            |
| Pricing         | https://aeoengine.ai/pricing             |
| Report template | https://aeoengine.ai/aeo-report-template |

## Screenshot capture: blocked (no reference screenshots exist)

**No screenshots of the reference site were captured.** Every automated request was refused, so this
folder deliberately contains no reference screenshots.

What was attempted on 2026-10-22:

1. `WebFetch` of all four URLs (plus `/pricing.md` and `/llms.txt`): **HTTP 403 Forbidden** each time.
2. A real headless Chromium session (Playwright 1.64, desktop 1440×900 and mobile 390×844, normal browser
   user agents), using [`scripts/capture-reference.mjs`](../../scripts/capture-reference.mjs): **HTTP 403** on every page.
   The rendered page only said "This request was blocked".
3. `curl -I` showed the cause: `Server: Vercel`, `X-Vercel-Mitigated: deny`. The site's firewall denies
   automated clients.

Evidence kept in this folder:

- [`capture-blocked-403.png`](capture-blocked-403.png) shows the block page Chromium received. It is not a design reference.
- [`capture-log.json`](capture-log.json) is the raw log of the capture run, with status codes and page outline.

I made no attempt to get around the firewall (no proxies, fingerprint spoofing, or challenge solving). The site operator
chose to block automated access, and that choice was respected.

To add real references later, open the pages in a normal browser and save screenshots here with the names
the brief suggests: `homepage-desktop.png`, `homepage-mobile.png`, `platform-features.png`, `pricing.png`,
`report-layout.png`. The capture script still works if the site ever allows the request.

## Secondhand information (public search-engine results)

Web search returned short summaries of the vendor's own published pages. These are vendor marketing claims,
seen only indirectly, and were used **only for feature discovery**. No copy, branding, testimonials or assets were taken.

- **Positioning:** an "execution" platform for answer-engine optimization (AEO): tracking plus doing the work,
  not reports alone.
- **AI search tracking:** citations, share of voice and prompt-level performance across several answer engines.
- **On-page SEO agents:** watch Google Search Console trends, flag fixes, and move **approved** changes forward.
- **Content workflow:** research, writing and optimization, with review before anything is published to a CMS.
- **CMS integrations** (WordPress, Shopify and others), plus weekly reporting.
- **Pricing model:** high-touch, service-heavy monthly tiers that bundle article counts and tracked-prompt limits.

Comparable public AEO reporting templates (HubSpot, AirOps, Profound) organize reports around **visibility or
mention rate, citation count and sources, share of voice, sentiment, competitor benchmarks, prompt-level
answers, and an action plan**. Surfaced's report system covers the same areas, with explicit metric formulas
(see [`docs/metrics.md`](../metrics.md)).

Sources:

- [AEO Engine pricing (search summary)](https://aeoengine.ai/pricing.md)
- [AEO Engine vs. Brandlight](https://aeoengine.ai/vs/brandlight)
- [AEO Engine vs. Searchable](https://aeoengine.ai/vs/searchable)
- [HubSpot AEO dashboard template](https://www.hubspot.com/resources/templates/aeo-dashboard)
- [AirOps AEO research step](https://docs.airops.com/building-workflows/workflow-steps/aeo-research)
- [Profound AEO dashboards](https://www.tryprofound.com/features/answer-engine-insights/aeo-dashboard)

## How this shaped Surfaced (original design)

Without visual references, the design follows the brief's own art direction:

- **Marketing site:** deep navy / near-black background, an electric-indigo primary accent, a restrained cyan
  highlight, high-contrast type, and gradients only on hero and final CTA surfaces.
- **Dashboard:** light neutral surfaces, white cards, clear metric tiles, status badges and progress states.
- **Information architecture:** Audit, then Improve, then Measure. Separate feature pages for the SEO audit,
  AI visibility, the content studio and competitor analysis. A pricing page with a plan comparison table.
  A report layout built around the metrics listed above.
- **Product model:** Surfaced is a **self-service** SaaS with configurable plan limits. It is not a managed service.
  It **does not** promise ranking or AI-citation outcomes, and anything that would change a customer's site
  requires explicit approval.

The brand ("Surfaced"), logo, copy and illustrations are all original.
