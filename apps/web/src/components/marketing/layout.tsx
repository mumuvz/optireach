import { ChevronDown, Menu } from 'lucide-react';
import { Dialog as RadixDialog, NavigationMenu } from 'radix-ui';
import { useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { Logo } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { SheetContent } from '@/components/ui/dialog';
import { cn } from '@/lib/cn';
import { APP_NAME, CONTACT_EMAIL } from '@/lib/config';
import { FEATURE_LINKS, FOOTER_COLUMNS, MAIN_NAV } from '@/content/site';

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'rounded-md px-3 py-2 text-sm font-medium transition-colors hover:text-white',
    isActive ? 'text-white' : 'text-slate-300',
  );

function FeaturesMenu() {
  return (
    <NavigationMenu.Root className="relative" delayDuration={80}>
      <NavigationMenu.List className="flex items-center">
        <NavigationMenu.Item>
          <NavigationMenu.Trigger className="group inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:text-white data-[state=open]:text-white">
            Features
            <ChevronDown
              className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
              aria-hidden
            />
          </NavigationMenu.Trigger>
          <NavigationMenu.Content className="absolute top-full left-0 mt-2 w-[min(92vw,34rem)] rounded-xl border border-border bg-popover p-2 shadow-2xl">
            <ul className="grid gap-1 sm:grid-cols-2">
              {FEATURE_LINKS.map(({ label, to, description, icon: Icon }) => (
                <li key={to}>
                  <NavigationMenu.Link asChild>
                    <Link to={to} className="flex gap-3 rounded-lg p-3 hover:bg-muted focus-visible:bg-muted">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                        <Icon className="size-4" aria-hidden />
                      </span>
                      <span>
                        <span className="block text-sm font-medium text-foreground">{label}</span>
                        <span className="block text-[13px] leading-snug text-muted-foreground">
                          {description}
                        </span>
                      </span>
                    </Link>
                  </NavigationMenu.Link>
                </li>
              ))}
              <li className="sm:col-span-2">
                <NavigationMenu.Link asChild>
                  <Link
                    to="/features"
                    className="block rounded-lg px-3 py-2 text-[13px] font-medium text-primary hover:bg-muted"
                  >
                    See all features →
                  </Link>
                </NavigationMenu.Link>
              </li>
            </ul>
          </NavigationMenu.Content>
        </NavigationMenu.Item>
      </NavigationMenu.List>
    </NavigationMenu.Root>
  );
}

export function MarketingHeader() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-[#070b18]/85 backdrop-blur supports-[backdrop-filter]:bg-[#070b18]/70">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Logo className="text-white" />
        <nav aria-label="Main" className="ml-6 hidden items-center lg:flex">
          <FeaturesMenu />
          {MAIN_NAV.filter((item) => item.to !== '/features').map((item) => (
            <NavLink key={item.to} to={item.to} className={navLinkClass}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto hidden items-center gap-2 lg:flex">
          <Button asChild variant="ghost" className="text-slate-200 hover:bg-white/5 hover:text-white">
            <Link to="/login">Log in</Link>
          </Button>
          <Button asChild>
            <Link to="/register">Start free</Link>
          </Button>
        </div>
        <RadixDialog.Root open={open} onOpenChange={setOpen}>
          <RadixDialog.Trigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto text-slate-200 hover:bg-white/5 hover:text-white lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="size-5" />
            </Button>
          </RadixDialog.Trigger>
          <SheetContent className="theme-dark p-5" aria-describedby={undefined}>
            <RadixDialog.Title className="sr-only">Menu</RadixDialog.Title>
            <Logo />
            <nav aria-label="Mobile" className="mt-6 grid gap-1" key={location.pathname}>
              {[
                { label: 'All features', to: '/features' },
                ...FEATURE_LINKS,
                ...MAIN_NAV.filter((i) => i.to !== '/features'),
                { label: 'Free site audit', to: '/free-audit' },
              ].map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  onClick={() => setOpen(false)}
                  className="rounded-md px-3 py-2.5 text-[15px] font-medium text-foreground hover:bg-muted"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="mt-6 grid gap-2">
              <Button asChild variant="outline">
                <Link to="/login" onClick={() => setOpen(false)}>
                  Log in
                </Link>
              </Button>
              <Button asChild>
                <Link to="/register" onClick={() => setOpen(false)}>
                  Start free
                </Link>
              </Button>
            </div>
          </SheetContent>
        </RadixDialog.Root>
      </div>
    </header>
  );
}

export function MarketingFooter() {
  return (
    <footer className="border-t border-white/5 bg-[#050813]">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.4fr_repeat(3,1fr)] lg:px-8">
        <div className="space-y-4">
          <Logo className="text-white" />
          <p className="max-w-xs text-sm leading-relaxed text-slate-400">
            SEO, answer engine and generative engine optimization in one workspace, with metrics you can trace
            back to the data.
          </p>
          <p className="text-sm text-slate-400">
            <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white">
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
        {FOOTER_COLUMNS.map((column) => (
          <nav key={column.title} aria-label={column.title}>
            <h2 className="text-sm font-semibold text-white">{column.title}</h2>
            <ul className="mt-4 space-y-2.5">
              {column.links.map((link) => (
                <li key={link.to}>
                  <Link to={link.to} className="text-sm text-slate-400 transition-colors hover:text-white">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="border-t border-white/5">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-[13px] text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          {/* The year may differ between prerender time and view time. */}
          <p suppressHydrationWarning>
            © {new Date().getFullYear()} {APP_NAME}. All rights reserved.
          </p>
          <p>
            Scores and metrics are diagnostic and calculated from the data we collect. They do not guarantee
            rankings or AI citations.
          </p>
        </div>
      </div>
    </footer>
  );
}

export function MarketingLayout() {
  return (
    <div className="theme-dark min-h-dvh bg-background text-foreground">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <MarketingHeader />
      <main id="main">
        <Outlet />
      </main>
      <MarketingFooter />
    </div>
  );
}

/** Standard marketing page container. */
export function Section({
  className,
  children,
  id,
}: {
  className?: string;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section id={id} className={cn('mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8', className)}>
      {children}
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  text,
  align = 'center',
}: {
  eyebrow?: string;
  title: string;
  text?: string;
  align?: 'center' | 'left';
}) {
  return (
    <div className={cn('max-w-3xl', align === 'center' && 'mx-auto text-center')}>
      {eyebrow ? (
        <p className="text-sm font-semibold tracking-wide text-indigo-300 uppercase">{eyebrow}</p>
      ) : null}
      <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">{title}</h2>
      {text ? <p className="mt-4 text-[17px] leading-relaxed text-slate-300">{text}</p> : null}
    </div>
  );
}
