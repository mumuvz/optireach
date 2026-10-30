// A keyless Google Maps view of the business location, with the local competitors discovered near it listed and
// linked to their own Google Maps place. Google's embeddable map needs no API key but can only center one pin, so
// competitors are shown as a distance-sorted list of links rather than drawn as markers — honest and dependency-free.
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, MapPin } from 'lucide-react';
import type { CompetitorDto, LocationDto } from '@surfaced/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeaderRow } from '@/components/ui/card';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';

/** Great-circle distance in km between two points. */
function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return r * 2 * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** A Google Maps link to the competitor's place (by place ID when known, else by coordinates). */
function mapsLink(c: CompetitorDto): string {
  const q = encodeURIComponent(c.name);
  if (c.placeId) return `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${c.placeId}`;
  if (c.latitude !== null && c.longitude !== null)
    return `https://www.google.com/maps/search/?api=1&query=${c.latitude},${c.longitude}`;
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

export function CompetitorMap({ projectId, location }: { projectId: string; location: LocationDto }) {
  const competitors = useQuery({
    queryKey: ['local-competitors', projectId],
    queryFn: () => api.get<CompetitorDto[]>(`/projects/${projectId}/local/competitors`),
  });
  const hasCenter = location.latitude !== null && location.longitude !== null;
  const nearby = (competitors.data ?? [])
    .filter((c) => c.status !== 'DISMISSED' && c.latitude !== null && c.longitude !== null)
    .map((c) => ({
      ...c,
      distance: hasCenter
        ? distanceKm(location.latitude!, location.longitude!, c.latitude!, c.longitude!)
        : null,
    }))
    .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity))
    .slice(0, 25);
  const embedSrc = hasCenter
    ? `https://maps.google.com/maps?q=${location.latitude},${location.longitude}&z=14&output=embed`
    : null;

  return (
    <Card>
      <CardHeaderRow
        title="Competitor map"
        description={`${location.name}, ${location.city} and the local competitors found near it. Links open each place on Google Maps.`}
      />
      <CardContent className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        {embedSrc ? (
          <iframe
            title={`Map of ${location.name}`}
            src={embedSrc}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            className="h-72 w-full rounded-lg border border-border lg:h-full"
          />
        ) : (
          <div className="flex h-72 items-center justify-center rounded-lg border border-dashed border-border px-6 text-center text-sm text-muted-foreground">
            Add this location’s coordinates to show it on the map.
          </div>
        )}
        <div className="grid content-start gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">Competitors nearby ({nearby.length})</p>
          {competitors.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !nearby.length ? (
            <p className="text-sm text-muted-foreground">
              No competitors with a location yet. They are discovered from Map rank scans.
            </p>
          ) : (
            <ul className="grid gap-1.5">
              {nearby.map((c) => (
                <li
                  key={c.id}
                  className="flex items-start justify-between gap-2 rounded-md border border-border px-2.5 py-1.5"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-medium">
                      <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{c.name}</span>
                      {c.status === 'SUGGESTED' ? <Badge tone="warning">Suggested</Badge> : null}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {[
                        c.category,
                        c.rating !== null
                          ? `${c.rating}★${c.reviewCount !== null ? ` (${formatNumber(c.reviewCount)})` : ''}`
                          : null,
                        c.distance !== null
                          ? `${c.distance < 1 ? `${Math.round(c.distance * 1000)} m` : `${c.distance.toFixed(1)} km`} away`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <a
                    href={mapsLink(c)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label={`View ${c.name} on Google Maps`}
                  >
                    <ExternalLink className="size-4" />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
