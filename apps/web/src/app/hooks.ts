// Project-scoped queries shared by several pages. Query keys start with the resource name and
// the project id, so mutations can invalidate a whole module at once.
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { isActiveStatus } from '@/lib/query';
import type {
  AuditRunSummary,
  CitationDomainDto,
  ContentDocumentDto,
  IssueSummaryDto,
  PromptDto,
  RecommendationDto,
  VisibilitySummaryDto,
  VisibilityTrendDto,
} from '@/lib/types';

export function useAuditRuns(projectId: string, page = 1, pageSize = 10) {
  return useQuery({
    queryKey: ['audits', projectId, page, pageSize],
    queryFn: () => api.page<AuditRunSummary>(`/projects/${projectId}/audits`, { page, pageSize }),
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => isActiveStatus(r.status) || isActiveStatus(r.crawlStatus))
        ? 3000
        : false,
  });
}

export function useIssueSummary(projectId: string) {
  return useQuery({
    queryKey: ['issues', projectId, 'summary'],
    queryFn: () => api.get<IssueSummaryDto>(`/projects/${projectId}/issues/summary`),
  });
}

export interface VisibilityFilterState {
  provider: string;
  country?: string;
  language?: string;
  /** Days back from now; null = all time. */
  days: number | null;
  includeDemo: boolean;
}

export const DEFAULT_VISIBILITY_FILTER: VisibilityFilterState = {
  provider: 'all',
  days: 30,
  includeDemo: true,
};

export function filterQuery(f: VisibilityFilterState) {
  return {
    provider: f.provider,
    country: f.country,
    language: f.language,
    from: f.days ? new Date(Date.now() - f.days * 86_400_000).toISOString().slice(0, 10) : undefined,
    includeDemo: f.includeDemo ? undefined : 'false',
  };
}

function filterKey(f: VisibilityFilterState) {
  return [f.provider, f.country ?? '', f.language ?? '', f.days ?? 'all', f.includeDemo] as const;
}

export function useVisibilitySummary(
  projectId: string,
  f: VisibilityFilterState = DEFAULT_VISIBILITY_FILTER,
) {
  return useQuery({
    queryKey: ['visibility', projectId, 'summary', ...filterKey(f)],
    queryFn: () =>
      api.get<VisibilitySummaryDto>(`/projects/${projectId}/ai-visibility/summary`, filterQuery(f)),
    placeholderData: (prev) => prev,
  });
}

export function useVisibilityTrend(
  projectId: string,
  f: VisibilityFilterState,
  bucket: 'day' | 'week' | 'month',
) {
  return useQuery({
    queryKey: ['visibility', projectId, 'trend', bucket, ...filterKey(f)],
    queryFn: () =>
      api.get<VisibilityTrendDto>(`/projects/${projectId}/ai-visibility/trend`, {
        ...filterQuery(f),
        bucket,
      }),
    placeholderData: (prev) => prev,
  });
}

export function useCitationDomains(projectId: string, f: VisibilityFilterState) {
  return useQuery({
    queryKey: ['visibility', projectId, 'citations', ...filterKey(f)],
    queryFn: () =>
      api.get<CitationDomainDto[]>(`/projects/${projectId}/ai-visibility/citations`, filterQuery(f)),
    placeholderData: (prev) => prev,
  });
}

export function usePrompts(projectId: string, page = 1, pageSize = 50) {
  return useQuery({
    queryKey: ['prompts', projectId, page, pageSize],
    queryFn: () => api.page<PromptDto>(`/projects/${projectId}/prompts`, { page, pageSize }),
  });
}

export function useDocuments(
  projectId: string,
  opts: { page?: number; pageSize?: number; status?: string; q?: string } = {},
) {
  const { page = 1, pageSize = 20, status, q } = opts;
  return useQuery({
    queryKey: ['content', projectId, 'documents', page, pageSize, status ?? '', q ?? ''],
    queryFn: () =>
      api.page<ContentDocumentDto>(`/projects/${projectId}/content/documents`, { page, pageSize, status, q }),
  });
}

export function useRecommendations(
  projectId: string,
  opts: { page?: number; pageSize?: number; status?: string; category?: string; severity?: string } = {},
) {
  const { page = 1, pageSize = 20, status, category, severity } = opts;
  return useQuery({
    queryKey: ['recommendations', projectId, page, pageSize, status ?? '', category ?? '', severity ?? ''],
    queryFn: () =>
      api.getWithMeta<{ items: RecommendationDto[]; byStatus: Record<string, number> }>(
        `/projects/${projectId}/recommendations`,
        { page, pageSize, status, category, severity },
      ),
  });
}
