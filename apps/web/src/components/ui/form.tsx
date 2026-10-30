import { Check, ChevronDown } from 'lucide-react';
import { Checkbox as RadixCheckbox, Label as RadixLabel, Switch as RadixSwitch } from 'radix-ui';
import {
  useId,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
} from 'react';
import { cn } from '@/lib/cn';

const fieldBase =
  'w-full rounded-md border border-input bg-card px-3 text-sm text-foreground shadow-xs transition-colors placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-destructive';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(fieldBase, 'h-9 py-1', className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea className={cn(fieldBase, 'min-h-24 py-2 leading-relaxed', className)} {...props} />;
}

/** Native select: accessible, keyboard friendly and works without JavaScript. */
export function NativeSelect({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <div className="relative">
      <select className={cn(fieldBase, 'h-9 appearance-none py-1 pr-8', className)} {...props}>
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
    </div>
  );
}

export function Label({ className, ...props }: ComponentProps<typeof RadixLabel.Root>) {
  return (
    <RadixLabel.Root
      className={cn('text-sm leading-none font-medium text-foreground', className)}
      {...props}
    />
  );
}

export function FieldError({ id, children }: { id?: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <p id={id} role="alert" className="text-[13px] text-destructive">
      {children}
    </p>
  );
}

interface FieldProps {
  label: ReactNode;
  /** The control; it receives id, aria-invalid and aria-describedby. */
  children: ReactElement<Record<string, unknown>>;
  error?: string;
  description?: ReactNode;
  className?: string;
  optional?: boolean;
}

/** Label + control + description + error, wired together for screen readers. */
export function Field({ label, children, error, description, className, optional }: FieldProps) {
  const id = useId();
  const controlId = (isValidElement(children) && (children.props.id as string | undefined)) || id;
  const descId = description ? `${controlId}-desc` : undefined;
  const errId = error ? `${controlId}-err` : undefined;
  const control = cloneElement(children, {
    id: controlId,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': [descId, errId].filter(Boolean).join(' ') || undefined,
  });
  return (
    <div className={cn('grid gap-1.5', className)}>
      <Label htmlFor={controlId}>
        {label}
        {optional ? <span className="ml-1 font-normal text-muted-foreground">(optional)</span> : null}
      </Label>
      {control}
      {description ? (
        <p id={descId} className="text-[13px] text-muted-foreground">
          {description}
        </p>
      ) : null}
      <FieldError id={errId}>{error}</FieldError>
    </div>
  );
}

export function Checkbox({ className, ...props }: ComponentProps<typeof RadixCheckbox.Root>) {
  return (
    <RadixCheckbox.Root
      className={cn(
        'peer size-4 shrink-0 rounded-[4px] border border-input bg-card shadow-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        className,
      )}
      {...props}
    >
      <RadixCheckbox.Indicator className="flex items-center justify-center">
        <Check className="size-3.5" strokeWidth={3} />
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}

export function Switch({ className, ...props }: ComponentProps<typeof RadixSwitch.Root>) {
  return (
    <RadixSwitch.Root
      className={cn(
        'inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=unchecked]:bg-input',
        className,
      )}
      {...props}
    >
      <RadixSwitch.Thumb className="pointer-events-none block size-4 rounded-full bg-white shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0.5" />
    </RadixSwitch.Root>
  );
}
