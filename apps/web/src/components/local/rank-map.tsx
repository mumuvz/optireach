import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, TileLayer, Tooltip, useMap } from 'react-leaflet';
import type { GridPointDto } from '@surfaced/shared';
import { BAND_STYLE, markerText, rankBand } from './rank-bands';

/** Tile server: OpenStreetMap by default (light use only, per its tile policy); set VITE_MAP_TILE_URL for production. */
const TILE_URL =
  (import.meta.env.VITE_MAP_TILE_URL as string | undefined) ||
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  (import.meta.env.VITE_MAP_TILE_ATTRIBUTION as string | undefined) ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function icon(p: GridPointDto, selected: boolean) {
  const s = BAND_STYLE[rankBand(p)];
  const size = selected ? 38 : 32;
  return L.divIcon({
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    html: `<span style="display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:9999px;background:${s.bg};color:${s.fg};font:600 13px/1 system-ui,sans-serif;border:2px solid ${selected ? '#0b0b0b' : '#ffffff'};box-shadow:0 1px 3px rgba(0,0,0,.35)">${markerText(p)}</span>`, // prettier-ignore
  });
}

function FitBounds({ points }: { points: GridPointDto[] }) {
  const map = useMap();
  const bounds = useMemo(() => L.latLngBounds(points.map((p) => [p.latitude, p.longitude] as [number, number])), [points]); // prettier-ignore
  useEffect(() => {
    if (points.length > 1) map.fitBounds(bounds.pad(0.25));
    else if (points[0]) map.setView([points[0].latitude, points[0].longitude], 15);
  }, [map, bounds, points]);
  return null;
}

export default function RankMap({
  points,
  selected,
  onSelect,
}: {
  points: GridPointDto[];
  selected: { row: number; col: number } | null;
  onSelect: (p: GridPointDto) => void;
}) {
  const center = points[Math.floor(points.length / 2)] ?? points[0];
  if (!center) return null;
  return (
    <MapContainer
      center={[center.latitude, center.longitude]}
      zoom={14}
      scrollWheelZoom={false}
      className="h-[420px] w-full rounded-lg border border-border"
      aria-label="Rank grid map"
    >
      <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
      <FitBounds points={points} />
      {points.map((p) => {
        const isSelected = selected?.row === p.row && selected?.col === p.col;
        return (
          <Marker
            key={`${p.row}-${p.col}`}
            position={[p.latitude, p.longitude]}
            icon={icon(p, isSelected)}
            keyboard
            title={`Point ${p.row + 1}-${p.col + 1}: ${p.status === 'FOUND' ? `rank ${p.rank}` : BAND_STYLE[rankBand(p)].label}`}
            eventHandlers={{ click: () => onSelect(p) }}
          >
            <Tooltip direction="top" offset={[0, -14]}>
              {p.status === 'FOUND' ? `Rank ${p.rank}` : BAND_STYLE[rankBand(p)].label}
            </Tooltip>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
