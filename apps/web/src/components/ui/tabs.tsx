import { Accordion as RadixAccordion, Tabs as RadixTabs } from 'radix-ui';
import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';

export const Tabs = RadixTabs.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof RadixTabs.List>) {
  return (
    <RadixTabs.List
      className={cn(
        'inline-flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof RadixTabs.Trigger>) {
  return (
    <RadixTabs.Trigger
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[13px] font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-xs',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: ComponentProps<typeof RadixTabs.Content>) {
  return <RadixTabs.Content className={cn('mt-4 focus-visible:outline-none', className)} {...props} />;
}

export const Accordion = RadixAccordion.Root;

export function AccordionItem({ className, ...props }: ComponentProps<typeof RadixAccordion.Item>) {
  return <RadixAccordion.Item className={cn('border-b border-border', className)} {...props} />;
}

export function AccordionTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof RadixAccordion.Trigger>) {
  return (
    <RadixAccordion.Header className="flex">
      <RadixAccordion.Trigger
        className={cn(
          'group flex flex-1 items-center justify-between gap-4 py-4 text-left text-[15px] font-medium hover:text-primary focus-visible:outline-2 focus-visible:outline-ring',
          className,
        )}
        {...props}
      >
        {children}
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden
        />
      </RadixAccordion.Trigger>
    </RadixAccordion.Header>
  );
}

/**
 * Content stays in the DOM while collapsed (hidden), so prerendered pages contain every answer.
 * FAQ structured data must match text that is present on the page.
 */
export function AccordionContent({
  className,
  children,
  ...props
}: ComponentProps<typeof RadixAccordion.Content>) {
  return (
    <RadixAccordion.Content
      forceMount
      className="overflow-hidden text-sm leading-relaxed text-muted-foreground data-[state=closed]:hidden"
      {...props}
    >
      <div className={cn('pb-4', className)}>{children}</div>
    </RadixAccordion.Content>
  );
}
