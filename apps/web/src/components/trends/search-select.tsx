import { useEffect, useId, useMemo, useState } from 'react';
import { Input, Label } from '@/components/ui/form';

export interface SearchOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * A text box with a searchable list (combobox): the default options on focus, matches while typing, keyboard
 * support. With `allowFree`, typed text that matches no option can be used as it is.
 */
export function SearchSelect({
  label,
  optional,
  options,
  defaultOptions,
  display,
  placeholder,
  description,
  listLabel,
  allowFree,
  emptyText,
  onSelect,
}: {
  label: string;
  optional?: boolean;
  options: SearchOption[];
  /** Shown on focus before anything is typed (default: the first 50 options). */
  defaultOptions?: SearchOption[];
  /** Text shown while the list is closed (the current choice). */
  display: string;
  placeholder?: string;
  description?: string;
  listLabel: string;
  allowFree?: boolean;
  emptyText?: string;
  onSelect: (value: string) => void;
}) {
  const inputId = useId();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return defaultOptions ?? options.slice(0, 50);
    const starts = (o: SearchOption) => (o.label.toLowerCase().startsWith(q) ? 0 : 1);
    const found = options
      .filter((o) => o.label.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q))
      .sort((a, b) => starts(a) - starts(b) || a.label.localeCompare(b.label))
      .slice(0, 50);
    const exact = found.some((o) => o.label.toLowerCase() === q);
    return allowFree && !exact
      ? [...found, { value: query.trim(), label: `Use “${query.trim()}”`, hint: 'Not in the list' }]
      : found;
  }, [query, options, defaultOptions, allowFree]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);
  const choose = (o: SearchOption) => {
    onSelect(o.value);
    setQuery('');
    setOpen(false);
  };
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={inputId}>
        {label}
        {optional ? <span className="ml-1 font-normal text-muted-foreground">(optional)</span> : null}
      </Label>
      <div className="relative">
        <Input
          id={inputId}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          value={open ? query : display}
          placeholder={placeholder}
          onFocus={() => {
            setQuery('');
            setActive(0);
            setOpen(true);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onBlur={() => {
            // Typed text that was not picked from the list is kept when free text is allowed.
            if (allowFree && open && query.trim()) onSelect(query.trim());
            setOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(matches.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter' && open && matches[active]) {
              e.preventDefault();
              choose(matches[active]);
            } else if (e.key === 'Escape') {
              setQuery('');
              setOpen(false);
            }
          }}
        />
        {open ? (
          <ul
            id={listId}
            role="listbox"
            aria-label={listLabel}
            className="absolute top-full z-30 mt-1 max-h-72 w-full min-w-64 overflow-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            {matches.map((o, i) => (
              <li
                key={`${o.value}-${i}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                // mousedown keeps focus in the input, so the choice lands before blur closes the list
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActive(i)}
                className={`cursor-default rounded-md px-2 py-1.5 text-sm ${i === active ? 'bg-muted' : ''}`}
              >
                <span className="font-medium">{o.label}</span>
                {o.hint ? <span className="block text-xs text-muted-foreground">{o.hint}</span> : null}
              </li>
            ))}
            {!matches.length ? (
              <li className="px-2 py-1.5 text-sm text-muted-foreground">
                {emptyText ?? `Nothing matches “${query}”.`}
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {description ? <p className="text-[13px] text-muted-foreground">{description}</p> : null}
    </div>
  );
}
