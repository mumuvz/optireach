// Deterministic brand/competitor mention matching and citation normalization.
import {
  domainOf,
  isSameOrSubdomain,
  type CitationSourceType,
  type MentionEntityType,
  type MentionMatchType,
} from '@surfaced/shared';
import type { EntityRef, ProviderCitation } from './providers';

export interface EntitySpec extends EntityRef {
  type: MentionEntityType;
}

export interface MatchedMention {
  entity: EntitySpec;
  matchedText: string;
  matchType: MentionMatchType;
  position: number;
  rank: number;
  snippet: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Unicode-aware whole-word pattern (letters/digits must not touch the match on either side). */
function wordPattern(term: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(term.trim())}(?![\\p{L}\\p{N}])`, 'iu');
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 120);
  const end = Math.min(text.length, index + length + 120);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`.slice(
    0,
    500,
  );
}

/** Finds the first mention of each entity (by name, alias or domain) and ranks entities by order of appearance. */
export function findMentions(text: string, entities: EntitySpec[]): MatchedMention[] {
  const found: Omit<MatchedMention, 'rank'>[] = [];
  for (const entity of entities) {
    let best: Omit<MatchedMention, 'rank'> | null = null;
    const terms: { term: string; type: MentionMatchType }[] = [
      { term: entity.name, type: 'NAME' },
      ...entity.aliases.filter((a) => a.trim().length >= 2).map((term) => ({ term, type: 'ALIAS' as const })),
    ];
    for (const { term, type } of terms) {
      if (term.trim().length < 2) continue;
      const match = wordPattern(term).exec(text);
      if (match && (best === null || match.index < best.position)) {
        best = {
          entity,
          matchedText: match[0],
          matchType: type,
          position: match.index,
          snippet: snippetAround(text, match.index, match[0].length),
        };
      }
    }
    if (entity.domain) {
      const index = text.toLowerCase().indexOf(entity.domain.toLowerCase());
      // "<=" so that "acme.com" is recorded as a domain mention rather than the name inside it.
      if (index !== -1 && (best === null || index <= best.position)) {
        best = {
          entity,
          matchedText: text.slice(index, index + entity.domain.length),
          matchType: 'DOMAIN',
          position: index,
          snippet: snippetAround(text, index, entity.domain.length),
        };
      }
    }
    if (best) found.push(best);
  }
  return found.sort((a, b) => a.position - b.position).map((m, index) => ({ ...m, rank: index + 1 }));
}

export interface NormalizedCitation {
  url: string;
  domain: string;
  title: string | null;
  position: number;
  sourceType: CitationSourceType;
  isOwnedDomain: boolean;
  competitorId: string | null;
}

const SOURCE_PRIORITY: Record<CitationSourceType, number> = {
  INLINE_CITATION: 3,
  SEARCH_RESULT: 2,
  MENTIONED_URL: 1,
};

/** Removes common tracking parameters added by answer engines (e.g. utm_source=openai). */
function cleanCitationUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    for (const key of [...parsed.searchParams.keys()])
      if (/^utm_/i.test(key)) parsed.searchParams.delete(key);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

/** De-duplicates citations by URL (keeping the strongest source type) and attributes domains. */
export function normalizeCitations(
  citations: ProviderCitation[],
  brandDomain: string | null,
  competitors: EntityRef[],
): NormalizedCitation[] {
  const byUrl = new Map<string, NormalizedCitation>();
  let position = 0;
  for (const citation of citations) {
    const url = cleanCitationUrl(citation.url);
    const domain = url ? domainOf(url) : null;
    if (!url || !domain) continue;
    const existing = byUrl.get(url);
    if (existing) {
      if (SOURCE_PRIORITY[citation.sourceType] > SOURCE_PRIORITY[existing.sourceType])
        existing.sourceType = citation.sourceType;
      if (!existing.title && citation.title) existing.title = citation.title;
      continue;
    }
    position += 1;
    const competitor = competitors.find((c) => c.domain && isSameOrSubdomain(domain, c.domain));
    byUrl.set(url, {
      url: url.slice(0, 2048),
      domain,
      title: citation.title?.slice(0, 500) ?? null,
      position,
      sourceType: citation.sourceType,
      isOwnedDomain: brandDomain !== null && Boolean(brandDomain) && isSameOrSubdomain(domain, brandDomain),
      competitorId: competitor?.id ?? null,
    });
  }
  return [...byUrl.values()];
}

/** URLs written in the answer text itself (used when a provider returns no structured citations). */
export function extractUrls(text: string): ProviderCitation[] {
  const urls = text.match(/https?:\/\/[^\s<>()"'\]]+/g) ?? [];
  return [...new Set(urls.map((u) => u.replace(/[.,;:!?]+$/, '')))]
    .slice(0, 50)
    .map((url) => ({ url, title: null, sourceType: 'MENTIONED_URL' as const }));
}
