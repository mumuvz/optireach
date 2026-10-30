import { X } from 'lucide-react';
import { AlertDialog as RadixAlertDialog, Dialog as RadixDialog } from 'radix-ui';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Button } from './button';

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

const overlay = 'fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-[1px]';
const panel =
  'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-xl border border-border bg-card p-6 text-card-foreground shadow-xl focus:outline-none';

export function DialogContent({
  className,
  children,
  size = 'md',
  ...props
}: ComponentProps<typeof RadixDialog.Content> & { size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={overlay} />
      <RadixDialog.Content className={cn(panel, width, className)} {...props}>
        {children}
        <RadixDialog.Close
          className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-4" />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export function DialogHeader({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="space-y-1.5 pr-6">
      <RadixDialog.Title className="text-lg leading-tight font-semibold">{title}</RadixDialog.Title>
      {description ? (
        <RadixDialog.Description className="text-sm text-muted-foreground">
          {description}
        </RadixDialog.Description>
      ) : (
        <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
      )}
    </div>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
  );
}

interface ConfirmDialogProps {
  title: ReactNode;
  description: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  /** Runs on confirm; the dialog stays open (with a spinner) until the promise settles. */
  onConfirm: () => Promise<unknown> | unknown;
  trigger: ReactNode;
}

/** Confirmation for destructive or irreversible actions. */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = false,
  onConfirm,
  trigger,
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <RadixAlertDialog.Root open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <RadixAlertDialog.Trigger asChild>{trigger}</RadixAlertDialog.Trigger>
      <RadixAlertDialog.Portal>
        <RadixAlertDialog.Overlay className={overlay} />
        <RadixAlertDialog.Content className={cn(panel, 'max-w-md')}>
          <div className="space-y-2">
            <RadixAlertDialog.Title className="text-lg font-semibold">{title}</RadixAlertDialog.Title>
            <RadixAlertDialog.Description className="text-sm text-muted-foreground">
              {description}
            </RadixAlertDialog.Description>
          </div>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <RadixAlertDialog.Cancel asChild>
              <Button variant="outline" disabled={busy}>
                Cancel
              </Button>
            </RadixAlertDialog.Cancel>
            <Button
              variant={destructive ? 'destructive' : 'primary'}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </RadixAlertDialog.Content>
      </RadixAlertDialog.Portal>
    </RadixAlertDialog.Root>
  );
}

/** Slide-over panel (mobile navigation, detail drawers). */
export function SheetContent({
  className,
  children,
  side = 'right',
  ...props
}: ComponentProps<typeof RadixDialog.Content> & { side?: 'left' | 'right' }) {
  return (
    <RadixDialog.Portal>
      <RadixDialog.Overlay className={overlay} />
      <RadixDialog.Content
        className={cn(
          'fixed inset-y-0 z-50 flex w-[min(100vw-2.5rem,26rem)] flex-col overflow-y-auto border-border bg-card text-card-foreground shadow-xl focus:outline-none',
          side === 'right' ? 'right-0 border-l' : 'left-0 border-r',
          className,
        )}
        {...props}
      >
        {children}
        <RadixDialog.Close
          className="absolute top-3.5 right-3.5 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Close"
        >
          <X className="size-4" />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}
