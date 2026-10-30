import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { LOCATION_KIND_LABELS, type LocationDto } from '@surfaced/shared';
import { useProject } from '@/app/project-scope';
import { PageHeader } from '@/components/app/page';
import {
  LocationEditor,
  draftToInput,
  emptyLocationDraft,
  locationToDraft,
  validateLocationDraft,
  type LocationDraft,
} from '@/components/local/location-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/feedback';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useCan } from '@/lib/auth';

function address(l: LocationDto): string {
  if (l.kind === 'SERVICE_AREA') return `Serves ${l.serviceAreas.join(', ') || l.city}`;
  return [l.addressLine1, l.addressLine2, l.locality, [l.city, l.postalCode].filter(Boolean).join(' '), l.region].filter(Boolean).join(', '); // prettier-ignore
}

function LocationDialog({
  open,
  onOpenChange,
  location,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  location: LocationDto | null;
}) {
  const project = useProject();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<LocationDraft>(() => (location ? locationToDraft(location) : emptyLocationDraft({ name: project.name, country: project.targetCountries[0] ?? 'IN' }))); // prettier-ignore
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      location
        ? api.put<LocationDto>(`/projects/${project.id}/locations/${location.id}`, draftToInput(draft))
        : api.post<LocationDto>(`/projects/${project.id}/locations`, draftToInput(draft)),
    onSuccess: async () => {
      toast.success(location ? 'Location updated' : 'Location added');
      await queryClient.invalidateQueries({ queryKey: ['locations', project.id] });
      onOpenChange(false);
    },
    onError: (e) => {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setErrors(e.fieldErrors);
      else toast.error('Could not save the location', { description: errorMessage(e) });
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader
          title={location ? `Edit ${location.name}` : 'Add a location'}
          description="Only enter real details: they are compared with Google and your listings, never published without your approval."
        />
        <LocationEditor value={draft} onChange={setDraft} errors={errors} workspaceId={project.workspaceId} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            onClick={() => {
              const { errors: e } = validateLocationDraft(draft);
              setErrors(e);
              if (!Object.keys(e).length) save.mutate();
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function LocationsPage() {
  const project = useProject();
  const queryClient = useQueryClient();
  const canManage = useCan('local.manage');
  const [editing, setEditing] = useState<LocationDto | null | 'new'>(null);
  const locations = useQuery({
    queryKey: ['locations', project.id],
    queryFn: () => api.get<LocationDto[]>(`/projects/${project.id}/locations`),
  });
  const archive = async (l: LocationDto) => {
    await api.delete(`/projects/${project.id}/locations/${l.id}`);
    toast.success('Location archived');
    await queryClient.invalidateQueries({ queryKey: ['locations', project.id] });
  };
  return (
    <>
      <PageHeader
        title="Locations"
        description="The places the business serves customers from. Each location gets its own rank grids, competitors and checks."
        actions={
          canManage ? (
            <Button onClick={() => setEditing('new')}>
              <Plus /> Add location
            </Button>
          ) : undefined
        }
      />
      {locations.isLoading ? <LoadingBlock rows={3} /> : null}
      {locations.error ? (
        <ErrorState error={locations.error} onRetry={() => void locations.refetch()} />
      ) : null}
      {locations.data && !locations.data.length ? (
        <EmptyState
          icon={MapPin}
          title="No locations yet"
          description="Add where customers find the business: an address they visit, or the area you serve."
        />
      ) : null}
      <div className="grid gap-4 md:grid-cols-2">
        {(locations.data ?? []).map((l) => (
          <Card key={l.id}>
            <CardContent className="grid gap-2 pt-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="flex items-center gap-2 font-semibold">
                    {l.name}
                    {l.isPrimary ? (
                      <Badge tone="primary">
                        <Star className="size-3" aria-hidden /> Primary
                      </Badge>
                    ) : null}
                  </h2>
                  <p className="text-sm text-muted-foreground">{address(l)}</p>
                </div>
                {canManage ? (
                  <div className="flex gap-1">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Edit ${l.name}`}
                      onClick={() => setEditing(l)}
                    >
                      <Pencil />
                    </Button>
                    <ConfirmDialog
                      title={`Archive ${l.name}?`}
                      description="Its scans and history are kept; its tracked queries stop."
                      confirmLabel="Archive"
                      destructive
                      onConfirm={() => archive(l).catch((e: unknown) => toast.error(errorMessage(e)))}
                      trigger={
                        <Button size="icon-sm" variant="ghost" aria-label={`Archive ${l.name}`}>
                          <Trash2 />
                        </Button>
                      }
                    />
                  </div>
                ) : null}
              </div>
              <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Serves</dt>
                <dd>{LOCATION_KIND_LABELS[l.kind]}</dd>
                <dt className="text-muted-foreground">Category</dt>
                <dd>{l.primaryCategory ?? <span className="text-muted-foreground">Not set</span>}</dd>
                <dt className="text-muted-foreground">Phone</dt>
                <dd>{l.phone ?? <span className="text-muted-foreground">Not set</span>}</dd>
                <dt className="text-muted-foreground">Coordinates</dt>
                <dd>
                  {l.latitude !== null ? (
                    `${l.latitude}, ${l.longitude}`
                  ) : (
                    <span className="text-amber-700">
                      Not set: edit the location and click “Find from address” or paste a Google link (needed
                      for rank grids)
                    </span>
                  )}
                </dd>
                <dt className="text-muted-foreground">Hours</dt>
                <dd>
                  {l.openingHours.length ? (
                    `${l.openingHours.length} days set`
                  ) : (
                    <span className="text-muted-foreground">Not set</span>
                  )}
                </dd>
                <dt className="text-muted-foreground">Source</dt>
                <dd>
                  {l.source === 'BUSINESS_PROFILE'
                    ? 'Business Profile'
                    : l.source === 'IMPORT'
                      ? 'Import'
                      : 'Entered manually'}
                </dd>
              </dl>
            </CardContent>
          </Card>
        ))}
      </div>
      {editing ? (
        <LocationDialog
          key={editing === 'new' ? 'new' : editing.id}
          open
          onOpenChange={(v) => !v && setEditing(null)}
          location={editing === 'new' ? null : editing}
        />
      ) : null}
    </>
  );
}
