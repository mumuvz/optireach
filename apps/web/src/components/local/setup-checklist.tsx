import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleDashed,
  ShieldAlert,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import type { SetupStep } from '@surfaced/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { cn } from '@/lib/cn';

const ICON: Record<SetupStep['status'], { icon: typeof Circle; className: string; label: string }> = {
  done: { icon: CheckCircle2, className: 'text-emerald-600', label: 'Done' },
  todo: { icon: Circle, className: 'text-primary', label: 'To do' },
  admin: { icon: ShieldAlert, className: 'text-amber-600', label: 'Needs setup by an administrator' },
  optional: { icon: CircleDashed, className: 'text-muted-foreground', label: 'Optional' },
};

const storageKey = (projectId: string) => `local-setup-collapsed:${projectId}`;

/** "Get started": the steps that put data on the dashboard cards, in order, with where to do each. */
export function SetupChecklist({ projectId, steps }: { projectId: string; steps: SetupStep[] }) {
  const required = steps.filter((s) => s.status !== 'optional');
  const done = required.filter((s) => s.status === 'done').length;
  const next = steps.find((s) => s.status === 'todo');
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(storageKey(projectId)) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(storageKey(projectId), c ? '0' : '1');
      } catch {
        // Storage can be unavailable (private mode); the panel then simply stays open next time.
      }
      return !c;
    });
  };
  if (!steps.length || (done === required.length && !steps.some((s) => s.status === 'optional'))) return null;
  return (
    <Card className="mb-5">
      <CardHeaderRow
        title={
          <span className="flex flex-wrap items-center gap-2">
            Get started
            <Badge tone={done === required.length ? 'success' : 'primary'}>
              {done} of {required.length} done
            </Badge>
          </span>
        }
        description={
          next
            ? `Most cards are empty until data is collected. Next: ${next.title.toLowerCase()}.`
            : 'Every step you can do here is done. Cards fill as new data is collected.'
        }
        actions={
          <Button size="sm" variant="ghost" onClick={toggle} aria-expanded={!collapsed}>
            {collapsed ? <ChevronDown /> : <ChevronUp />} {collapsed ? 'Show steps' : 'Hide steps'}
          </Button>
        }
      />
      {collapsed ? null : (
        <CardContent>
          <ol className="divide-y divide-border">
            {steps.map((step, i) => {
              const meta = ICON[step.status];
              const Icon = meta.icon;
              return (
                <li key={step.key} className={cn('flex gap-3 py-3', step.status === 'done' && 'opacity-70')}>
                  <Icon className={cn('mt-0.5 size-5 shrink-0', meta.className)} aria-label={meta.label} />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      <span>
                        {i + 1}. {step.title}
                      </span>
                      {step.status === 'admin' ? (
                        <Badge tone="warning">Needs administrator setup</Badge>
                      ) : null}
                      {step.status === 'optional' ? <Badge>Optional</Badge> : null}
                    </p>
                    {step.status !== 'done' ? (
                      <p className="mt-0.5 text-[13px] text-muted-foreground">{step.detail}</p>
                    ) : null}
                    <p className="mt-0.5 text-xs text-muted-foreground">Fills: {step.fills.join(', ')}</p>
                  </div>
                  {step.action && step.status !== 'done' ? (
                    <Button
                      asChild
                      size="sm"
                      variant={step === next ? 'primary' : 'outline'}
                      className="shrink-0 self-start"
                    >
                      <Link to={step.action.to}>
                        {step.action.label} <ArrowRight />
                      </Link>
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </CardContent>
      )}
    </Card>
  );
}
