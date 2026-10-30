// Chart building blocks (Recharts). Conventions: one y-axis per chart, solid hairline grid,
// 2px lines with ringed markers, thin bars with 4px rounded data-ends, a legend for two or more
// series, values in the tooltip first, and a table view for every chart.
import { Table2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { CHROME, DEEMPHASIS, SEQ_FILL, SEQ_TRACK } from './palette';

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

type Row = Record<string, string | number | null>;

/** Figure wrapper: title, optional legend, and a table-view toggle (the accessible twin of the chart). */
export function ChartFrame({
  title,
  description,
  legend,
  table,
  children,
  className,
  actions,
}: {
  title: ReactNode;
  description?: ReactNode;
  legend?: { label: string; color: string; kind?: 'line' | 'rect'; value?: string }[];
  table: { columns: string[]; rows: (string | number)[][] };
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  const id = useId();
  return (
    <figure className={cn('min-w-0', className)} aria-labelledby={`${id}-title`}>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <figcaption id={`${id}-title`} className="text-sm font-semibold">
            {title}
          </figcaption>
          {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
        </div>
        <div className="flex items-center gap-1">
          {actions}
          <Button variant="ghost" size="sm" onClick={() => setShowTable((v) => !v)} aria-pressed={showTable}>
            <Table2 /> {showTable ? 'Chart' : 'Table'}
          </Button>
        </div>
      </div>
      {legend && legend.length > 1 ? (
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs" aria-label="Legend">
          {legend.map((item) => (
            <li key={item.label} className="flex items-center gap-1.5 text-foreground">
              {item.kind === 'rect' ? (
                <span className="size-2.5 rounded-[3px]" style={{ background: item.color }} aria-hidden />
              ) : (
                <span className="h-0.5 w-3.5 rounded-full" style={{ background: item.color }} aria-hidden />
              )}
              <span>{item.label}</span>
              {item.value ? <span className="font-medium tabular-nums">{item.value}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {showTable ? (
        <div className="max-h-80 overflow-auto rounded-lg border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-muted">
              <tr>
                {table.columns.map((c) => (
                  <th key={c} scope="col" className="px-3 py-2 text-left font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i} className="border-t border-border">
                  {row.map((cell, j) => (
                    <td key={j} className={cn('px-3 py-1.5', j > 0 && 'tabular-nums')}>
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </figure>
  );
}

interface TooltipRow {
  label: string;
  color: string;
  value: string;
}

function TooltipCard({ title, rows, footer }: { title: string; rows: TooltipRow[]; footer?: string }) {
  return (
    <div className="min-w-40 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 text-muted-foreground">{title}</p>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center gap-2">
            <span className="h-0.5 w-3 rounded-full" style={{ background: r.color }} aria-hidden />
            <span className="font-semibold text-foreground tabular-nums">{r.value}</span>
            <span className="text-muted-foreground">{r.label}</span>
          </li>
        ))}
      </ul>
      {footer ? <p className="mt-1.5 border-t border-border pt-1.5 text-muted-foreground">{footer}</p> : null}
    </div>
  );
}

/**
 * Multi-series line chart on one y-axis. Null values leave gaps (a bucket without data is not zero).
 * `footer` adds per-point context to the tooltip (e.g. the sample size).
 */
export function LineTrend({
  data,
  xKey,
  series,
  formatY,
  domain,
  height = 240,
  formatX,
  footer,
}: {
  data: Row[];
  xKey: string;
  series: SeriesDef[];
  formatY: (v: number) => string;
  domain?: [number, number];
  height?: number;
  formatX?: (v: string) => string;
  footer?: (row: Row) => string | undefined;
}) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke={CHROME.grid} strokeWidth={1} />
          <XAxis
            dataKey={xKey}
            tickFormatter={formatX}
            tick={{ fill: CHROME.tick, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: CHROME.baseline }}
            minTickGap={24}
          />
          <YAxis
            domain={domain ?? ['auto', 'auto']}
            tickFormatter={(v: number) => formatY(v)}
            tick={{ fill: CHROME.tick, fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            width={44}
          />
          <Tooltip
            cursor={{ stroke: CHROME.baseline, strokeWidth: 1 }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]!.payload as Row;
              return (
                <TooltipCard
                  title={formatX ? formatX(String(label)) : String(label)}
                  rows={series.map((s) => {
                    const v = row[s.key];
                    return {
                      label: s.label,
                      color: s.color,
                      value: typeof v === 'number' ? formatY(v) : 'no data',
                    };
                  })}
                  footer={footer?.(row)}
                />
              );
            }}
          />
          {series.map((s) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={{ r: 4, fill: s.color, stroke: CHROME.surface, strokeWidth: 2 }}
              activeDot={{ r: 5, fill: s.color, stroke: CHROME.surface, strokeWidth: 2 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Horizontal bars for comparing values across named items. Pass `emphasis` to color one item in
 * the accent hue and the rest as context (de-emphasis gray).
 */
export function HBars({
  data,
  formatValue,
  color,
  emphasisKey,
  max,
  rowHeight = 30,
}: {
  data: { key: string; label: string; value: number | null; note?: string }[];
  formatValue: (v: number) => string;
  /** Color for every bar (single series). */
  color: string;
  /** When set, only this item uses `color`; the others are de-emphasized. */
  emphasisKey?: string;
  max?: number;
  rowHeight?: number;
}) {
  const height = Math.max(60, data.length * rowHeight + 16);
  const values = data.map((d) => d.value ?? 0);
  const upper = max ?? Math.max(...values, 0) * 1.15;
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 56, bottom: 4, left: 4 }}
          barCategoryGap={6}
        >
          <CartesianGrid horizontal={false} stroke={CHROME.grid} strokeWidth={1} />
          <XAxis type="number" domain={[0, upper || 1]} hide />
          <YAxis
            type="category"
            dataKey="label"
            width={140}
            tick={{ fill: CHROME.tick, fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: CHROME.baseline }}
            interval={0}
          />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0]!.payload as (typeof data)[number];
              return (
                <TooltipCard
                  title={row.label}
                  rows={[
                    {
                      label: row.note ?? '',
                      color: emphasisKey && row.key !== emphasisKey ? DEEMPHASIS : color,
                      value: row.value === null ? 'no data' : formatValue(row.value),
                    },
                  ]}
                />
              );
            }}
          />
          <Bar
            dataKey="value"
            barSize={16}
            radius={[0, 4, 4, 0]}
            isAnimationActive={false}
            activeBar={{ fillOpacity: 0.8 }}
          >
            {data.map((d) => (
              <Cell key={d.key} fill={emphasisKey && d.key !== emphasisKey ? DEEMPHASIS : color} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              offset={8}
              formatter={(v: unknown) => (typeof v === 'number' ? formatValue(v) : '—')}
              style={{ fill: CHROME.ink, fontSize: 12 }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** One horizontal 100% bar split into segments with 2px surface gaps (part-to-whole, ≤ 7 segments). */
export function ShareBar({
  segments,
  label,
}: {
  segments: { key: string; label: string; share: number; color: string }[];
  label: string;
}) {
  const visible = segments.filter((s) => s.share > 0);
  return (
    <div
      role="img"
      aria-label={`${label}: ${visible.map((s) => `${s.label} ${Math.round(s.share * 100)}%`).join(', ')}`}
      className="flex h-6 w-full gap-[2px] overflow-hidden rounded-md"
    >
      {visible.map((s) => (
        <div
          key={s.key}
          title={`${s.label}: ${Math.round(s.share * 100)}%`}
          className="h-full first:rounded-l-md last:rounded-r-md"
          style={{ width: `${s.share * 100}%`, background: s.color }}
        />
      ))}
    </div>
  );
}

/** Meter for a 0–100 value: fill and track from the same blue ramp. */
export function Meter({ value, label }: { value: number | null; label: string }) {
  const v = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      className="h-2 w-full overflow-hidden rounded-full"
      style={{ background: SEQ_TRACK }}
    >
      <div className="h-full rounded-full" style={{ width: `${v}%`, background: SEQ_FILL }} />
    </div>
  );
}
