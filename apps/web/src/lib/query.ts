import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // Client errors (404, 403, validation) will not change on retry.
        retry: (failureCount, error) =>
          !(error instanceof ApiError && error.status > 0 && error.status < 500) && failureCount < 2,
      },
      mutations: { retry: false },
    },
  });
}

/** Poll every `ms` while a job-like record is still queued or running. */
export function pollWhileActive<T>(isActive: (data: T | undefined) => boolean, ms = 2000) {
  return (query: { state: { data: T | undefined } }) => (isActive(query.state.data) ? ms : false);
}

export const isActiveStatus = (status: string | null | undefined): boolean =>
  status === 'QUEUED' || status === 'RUNNING' || status === 'GENERATING' || status === 'PENDING';
