import { Check, ChevronsUpDown, X } from 'lucide-react';
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';
import { Popover, PopoverContent, PopoverTrigger } from './menu';

export interface Option {
  value: string;
  label: string;
}

/** Searchable multi-select (popover list with checkboxes) rendering the selection as chips. */
export function MultiSelect({
  options,
  value,
  onChange,
  placeholder = 'Select…',
  max,
  id,
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
}: {
  options: Option[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max?: number;
  id?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const listId = useId();
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o])), [options]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase() === q)
      : options;
    return list.slice(0, 200);
  }, [options, query]);
  const toggle = (v: string) => {
    if (value.includes(v)) onChange(value.filter((x) => x !== v));
    else if (!max || value.length < max) onChange([...value, v]);
  };
  return (
    <div className="grid gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            id={id}
            type="button"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-card px-3 text-left text-sm shadow-xs aria-[invalid=true]:border-destructive"
          >
            <span className={cn('truncate', !value.length && 'text-muted-foreground')}>
              {value.length ? `${value.length} selected` : placeholder}
            </span>
            <ChevronsUpDown className="size-4 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-64">
          <div className="border-b border-border p-2">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              aria-label="Search options"
              className="h-8 w-full rounded-md bg-muted px-2.5 text-sm outline-none"
            />
          </div>
          <ul id={listId} role="listbox" aria-multiselectable className="max-h-64 overflow-y-auto p-1">
            {filtered.map((o) => {
              const selected = value.includes(o.value);
              return (
                <li key={o.value} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    onClick={() => toggle(o.value)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                  >
                    <span
                      className={cn(
                        'flex size-4 items-center justify-center rounded-[4px] border',
                        selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                      )}
                    >
                      {selected ? <Check className="size-3" strokeWidth={3} /> : null}
                    </span>
                    <span className="flex-1 truncate">{o.label}</span>
                    <span className="text-xs text-muted-foreground uppercase">{o.value}</span>
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 ? (
              <li className="px-2 py-3 text-center text-sm text-muted-foreground">No matches</li>
            ) : null}
          </ul>
        </PopoverContent>
      </Popover>
      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected">
          {value.map((v) => (
            <li
              key={v}
              className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2.5 text-xs font-medium"
            >
              {byValue.get(v)?.label ?? v}
              <button
                type="button"
                onClick={() => toggle(v)}
                className="rounded-full p-0.5 hover:bg-background"
                aria-label={`Remove ${byValue.get(v)?.label ?? v}`}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Free-text tags: type and press Enter or comma to add. */
export function TagInput({
  value,
  onChange,
  placeholder,
  max = 50,
  id,
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
  maxLength = 200,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  max?: number;
  id?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  maxLength?: number;
}) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const parts = raw
      .split(/[,\n]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) {
      if (next.length >= max) break;
      if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p.slice(0, maxLength));
    }
    onChange(next);
    setDraft('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div
      className={cn(
        'flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-input bg-card px-2 py-1.5 shadow-xs focus-within:border-ring focus-within:outline-2 focus-within:outline-ring/40',
        invalid && 'border-destructive',
      )}
    >
      {value.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 rounded-full bg-muted py-0.5 pr-1 pl-2.5 text-xs font-medium"
        >
          {tag}
          <button
            type="button"
            onClick={() => onChange(value.filter((t) => t !== tag))}
            className="rounded-full p-0.5 hover:bg-background"
            aria-label={`Remove ${tag}`}
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(draft)}
        placeholder={value.length ? '' : placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="h-6 min-w-32 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground/80"
      />
    </div>
  );
}
