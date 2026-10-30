# AI answer and SERP data providers: implementation notes

Checked against provider documentation and terms on 2026-10-22. These notes drive the visibility, rank-tracking
and local-grid adapters. Re-check them before changing an adapter.

## Decisions

| Source                                                      | Decision                                                     | Reason                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OpenAI Responses API, `web_search`                          | **Used** (existing adapter)                                  | Official API. Answers approximate, but do not equal, ChatGPT search. `chat-latest` is the closest model to ChatGPT.                                                                                    |
| Gemini API without grounding                                | **Used** (`gemini_model_knowledge`)                          | Official API; shows what the model says about a brand without live search.                                                                                                                             |
| Gemini API with Grounding with Google Search or Google Maps | **Not used for tracking**                                    | The Gemini API Additional Terms forbid caching, analyzing or learning from Grounded Results, and programmatically collecting their links. Storing and analyzing answers is exactly what tracking does. |
| Google AI Overviews and AI Mode                             | **Licensed provider (optional) or manual observations**      | Google offers no API for them.                                                                                                                                                                         |
| Search Console "Generative AI performance" report           | **CSV import**                                               | First-party AI Overviews/AI Mode impressions. Export only, with no API; impressions only, for both features combined.                                                                                  |
| Organic rankings, local pack, Maps grid                     | **DataForSEO adapter (optional), imports or manual entries** | No official API. See the compliance note below.                                                                                                                                                        |
| Google ORGANIC rank (web results)                           | **Google Custom Search JSON API (free, optional)**           | Google’s own official API for organic web results, free up to 100 searches/day. NOT the Maps local pack, and country-level only (not per coordinate), so it measures a national organic SERP position. |
| Google Places API (Text Search)                             | **Not used**                                                 | Maps Platform terms forbid storing business names, addresses and ratings, so rank history cannot be kept.                                                                                              |

**Compliance note on SERP data.** Google's spam policies call automated rank-checking without permission a
violation of its terms. DataForSEO and SerpApi license their own collection, not Google's consent, and DataForSEO's
terms (section 7) make the customer responsible for compliant use. Surfaced therefore:

- disables the adapter unless the operator sets `SERP_PROVIDER=dataforseo` with credentials;
- labels every result "Licensed data provider (DataForSEO)" with the capture time;
- shows this note where the provider is enabled.

Search Console average position remains the first-party ranking measure.

## Google Programmable Search (Custom Search JSON API)

- `GET https://www.googleapis.com/customsearch/v1?key=&cx=&q=&num=&hl=&gl=`. Returns organic web results
  (`items[]` with `title`, `link`, `displayLink`); no place ID, rating, address or coordinates.
- The only **free, permitted** way to get real **Google** data. It is organic web results, **not** the Maps local
  pack — no free source provides that — and it localises by country (`gl`), not by coordinate.
- Enabled by `GOOGLE_CSE_API_KEY` + `GOOGLE_CSE_CX` (a free API key and a Programmable Search Engine ID). Free quota
  is 100 queries/day; one page of up to 10 results per request.
- In the rank tracker it is the `GOOGLE_CSE` source, usable only on the **ORGANIC** surface. A scan makes **one**
  request (the result is national), reused for every grid point, so organic queries use a 1×1 grid. Organic web
  pages are not local businesses, so organic scans do not create competitor suggestions. Scraping Google directly is
  never done: it breaks Google’s terms and risks the business’s own account.

## OpenAI web search

- Tool `{"type":"web_search"}` with `user_location: {type: "approximate", country, city, region, timezone}`. When
  the location is omitted, the API defaults to the United States, so a location is always sent.
- `include: ["web_search_call.action.sources"]` returns every consulted URL. Inline citations are `url_citation`
  annotations and must be shown as clickable links.
- Pricing: $10 per 1,000 web search calls plus tokens.

## Gemini API (ungrounded)

- `POST https://generativelanguage.googleapis.com/v1beta/interactions` (the recommended API since June 2026) with
  `{"model": "...", "input": "...", "store": false}`; `generateContent` remains supported.
- Stable models include `gemini-3.8-flash` and `gemini-3.5-flash-lite`. The adapter reads `GEMINI_MODEL`.

## Implementation status (2026-10-24)

- `gemini_model_knowledge`: `POST …/v1beta/models/{GEMINI_MODEL}:generateContent` with `x-goog-api-key`, a system
  instruction and the prompt, and **no `tools`** (no grounding). Thought parts are dropped. Not verified live.
- `dataforseo_ai_mode`: `POST /v3/serp/google/ai_mode/live/advanced` with one task (`keyword`, `language_code`,
  `device: mobile`, and `location_coordinate "lat,lng,11z"` from a business location in the prompt's city, else
  `location_name` = the country's English name). The answer is the `ai_overview` item's `markdown`; citations are
  its `references` and the elements' references and links, de-duplicated. A missing `ai_overview` is reported as
  "no AI Mode answer", never as "not mentioned". Requires `SERP_PROVIDER=dataforseo`. Not verified live.
- OpenAI web search now sends the prompt's city in `user_location`; Perplexity sends the country only.
- Manual observations (`manual_<surface>`) cover AI Overviews, the ChatGPT and Gemini apps, Copilot and others.

## DataForSEO

- Auth: HTTP Basic with the API login and password. Live endpoints take a JSON array with one task:
  - `POST /v3/serp/google/organic/live/advanced`: organic results; `load_async_ai_overview: true` adds the AI
    Overview item for $0.002 more (refunded when none appears).
  - `POST /v3/serp/google/ai_mode/live/advanced`: AI Mode answer with references.
  - `POST /v3/serp/google/maps/live/advanced`: Maps results with `rank_group`, `title`, `rating{value,
votes_count}`, `place_id`, `cid`, `address`, `phone`, `url`, `domain`, `category`, `latitude`, `longitude`.
- Location: `location_code`, `location_name`, or `location_coordinate` ("lat,lng,zoom" for Maps and AI Mode;
  "lat,lng,radius" for organic). Also `language_code` and `device` (desktop or mobile).
- `ai_overview` items: `markdown`, `items[]` with `links[]{url,domain}`, and `references[]{source,domain,url,title}`.
- Live prices: organic $0.002 per SERP of 10 results; AI Mode $0.004 per request; Maps $0.002 per 100 results.
  Queued modes cost less.
