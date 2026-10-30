import { useId } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/cn';
import { APP_NAME } from '@/lib/config';

/** Original mark: two water-surface waves with a point rising above them ("surfaced"). */
export function LogoMark({ className }: { className?: string }) {
  const gradient = `sf-logo-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden focusable="false">
      <defs>
        <linearGradient id={gradient} x1="0" y1="32" x2="32" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4f46e5" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradient})`} />
      <path
        d="M6.5 22c3 0 4.3-3.2 7.4-3.2s4.4 3.2 7.5 3.2 4.1-2 4.1-2"
        stroke="#fff"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M6.5 16.4c3 0 4.3-3.2 7.4-3.2s4.4 3.2 7.5 3.2"
        stroke="#fff"
        strokeWidth="2.2"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="23.6" cy="9.2" r="2.4" fill="#fff" />
    </svg>
  );
}

export function Logo({
  to = '/',
  className,
  label = true,
}: {
  to?: string;
  className?: string;
  label?: boolean;
}) {
  return (
    <Link
      to={to}
      className={cn('inline-flex items-center gap-2 rounded-md font-semibold tracking-tight', className)}
      aria-label={`${APP_NAME} home`}
    >
      <LogoMark />
      {label ? <span className="text-[17px]">{APP_NAME}</span> : null}
    </Link>
  );
}
