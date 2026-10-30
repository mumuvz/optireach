import { scoreBand } from '@surfaced/shared';
import { cn } from '@/lib/cn';

/** Colors follow the shared score bands (good ≥ 80, fair ≥ 50, poor below); neutral without a score. */
export function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined) return 'var(--muted-foreground)';
  return { good: '#10b981', fair: '#f59e0b', poor: '#ef4444' }[scoreBand(score)];
}

/** Circular 0–100 gauge for the site health index. */
export function ScoreRing({
  score,
  size = 120,
  label,
  className,
}: {
  score: number | null | undefined;
  size?: number;
  label: string;
  className?: string;
}) {
  const value = score === null || score === undefined ? 0 : Math.max(0, Math.min(100, score));
  const stroke = Math.max(6, Math.round(size / 12));
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const hasScore = score !== null && score !== undefined;
  return (
    <figure className={cn('inline-flex flex-col items-center', className)}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label={hasScore ? `${label}: ${Math.round(value)} out of 100` : `${label}: not available`}
        >
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--muted)" strokeWidth={stroke} />
          {hasScore ? (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={scoreColor(score)}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - value / 100)}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          ) : null}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
          <span className="font-semibold tabular-nums" style={{ fontSize: size / 4 }}>
            {hasScore ? Math.round(value) : '—'}
          </span>
          {hasScore ? <span className="text-[11px] text-muted-foreground">/ 100</span> : null}
        </div>
      </div>
      <figcaption className="mt-2 text-xs text-muted-foreground">{label}</figcaption>
    </figure>
  );
}
