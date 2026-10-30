import type { GridPointDto } from '@surfaced/shared';

export type RankBand = 'top3' | 'top10' | 'low' | 'notFound' | 'failed' | 'pending';

export function rankBand(p: Pick<GridPointDto, 'status' | 'rank'>): RankBand {
  if (p.status === 'FAILED') return 'failed';
  if (p.status === 'PENDING') return 'pending';
  if (p.rank === null) return 'notFound';
  if (p.rank <= 3) return 'top3';
  if (p.rank <= 10) return 'top10';
  return 'low';
}

/** Marker colours, always shown with the rank or a symbol, so rank is never shown by colour alone. */
export const BAND_STYLE: Record<RankBand, { bg: string; fg: string; label: string }> = {
  top3: { bg: '#1baf7a', fg: '#ffffff', label: 'Top 3' },
  top10: { bg: '#eda100', fg: '#0b0b0b', label: '4 to 10' },
  low: { bg: '#eb6834', fg: '#ffffff', label: 'Below 10' },
  notFound: { bg: '#e34948', fg: '#ffffff', label: 'Not found within the depth' },
  failed: { bg: '#898781', fg: '#ffffff', label: 'Not measured (failed)' },
  pending: { bg: '#e1e0d9', fg: '#52514e', label: 'Not measured yet' },
};

export function markerText(p: Pick<GridPointDto, 'status' | 'rank'>): string {
  if (p.status === 'FAILED') return '!';
  if (p.status === 'PENDING') return '·';
  return p.rank === null ? '–' : String(p.rank);
}
