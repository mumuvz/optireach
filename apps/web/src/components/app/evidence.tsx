/** Evidence is rule-specific JSON; render it as readable key/value rows. */
export function Evidence({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <p className="text-sm text-muted-foreground">No additional evidence.</p>;
  if (typeof value !== 'object') return <p className="text-sm">{String(value)}</p>;
  const entries = Array.isArray(value)
    ? value.map((v, i) => [String(i + 1), v] as const)
    : Object.entries(value as Record<string, unknown>);
  return (
    <dl className="divide-y divide-border text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="grid gap-1 py-2 sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted-foreground">{k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}</dt>
          <dd className="min-w-0 font-mono text-xs break-words">
            {typeof v === 'object' ? JSON.stringify(v) : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
