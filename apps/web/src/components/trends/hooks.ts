import { useQuery } from '@tanstack/react-query';
import type {
  TrendReportDto,
  TrendReportSummaryDto,
  TrendSavedQueryDto,
  TrendsStatusDto,
} from '@surfaced/shared';
import { api } from '@/lib/api';

const ACTIVE = new Set(['QUEUED', 'RUNNING']);

export function useTrendsStatus(projectId: string) {
  return useQuery({
    queryKey: ['trends-status', projectId],
    queryFn: () => api.get<TrendsStatusDto>(`/projects/${projectId}/trends/status`),
    staleTime: 30_000,
  });
}

export function useTrendCategories(projectId: string) {
  return useQuery({
    queryKey: ['trends-categories'],
    queryFn: () =>
      api.get<{ source: string; categories: [number, string, string][] }>(
        `/projects/${projectId}/trends/categories`,
      ),
    staleTime: Infinity,
  });
}

/** One report (or the latest when `reportId` is null), polled while it is being prepared. */
export function useTrendReport(projectId: string, reportId: string | null) {
  return useQuery({
    queryKey: ['trends', projectId, reportId ?? 'latest'],
    queryFn: () =>
      api.get<TrendReportDto | null>(
        reportId
          ? `/projects/${projectId}/trends/reports/${reportId}`
          : `/projects/${projectId}/trends/latest`,
      ),
    refetchInterval: (q) => (q.state.data && ACTIVE.has(q.state.data.status) ? 3000 : false),
  });
}

export function useTrendHistory(projectId: string) {
  return useQuery({
    queryKey: ['trends-history', projectId],
    queryFn: () => api.get<TrendReportSummaryDto[]>(`/projects/${projectId}/trends/reports`),
  });
}

export function useSavedComparisons(projectId: string) {
  return useQuery({
    queryKey: ['trends-saved', projectId],
    queryFn: () => api.get<TrendSavedQueryDto[]>(`/projects/${projectId}/trends/saved`),
  });
}

export const trendKeys = (projectId: string) => [
  ['trends', projectId],
  ['trends-history', projectId],
  ['trends-status', projectId],
  ['trends-saved', projectId],
];
