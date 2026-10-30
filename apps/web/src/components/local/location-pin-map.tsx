import 'leaflet/dist/leaflet.css';
import L from 'leaflet';
import { useEffect, useMemo } from 'react';
import { MapContainer, Marker, TileLayer, useMap } from 'react-leaflet';

const TILE_URL =
  (import.meta.env.VITE_MAP_TILE_URL as string | undefined) ||
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  (import.meta.env.VITE_MAP_TILE_ATTRIBUTION as string | undefined) ||
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const pin = L.divIcon({
  className: '',
  iconSize: [28, 28],
  iconAnchor: [14, 28],
  html: '<span style="display:block;width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:#2a78d6;border:3px solid #ffffff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></span>',
});

function Recenter({ latitude, longitude, zoom }: { latitude: number; longitude: number; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView([latitude, longitude], Math.max(map.getZoom(), zoom));
  }, [map, latitude, longitude, zoom]);
  return null;
}

/** A draggable pin: the user moves it onto the shop entrance, and the new position is reported. */
export default function LocationPinMap({
  latitude,
  longitude,
  zoom = 16,
  onMove,
}: {
  latitude: number;
  longitude: number;
  zoom?: number;
  onMove: (latitude: number, longitude: number) => void;
}) {
  const handlers = useMemo(
    () => ({
      dragend: (e: L.LeafletEvent) => {
        const p = (e.target as L.Marker).getLatLng();
        onMove(Math.round(p.lat * 1e7) / 1e7, Math.round(p.lng * 1e7) / 1e7);
      },
    }),
    [onMove],
  );
  return (
    <MapContainer
      center={[latitude, longitude]}
      zoom={zoom}
      scrollWheelZoom={false}
      className="h-56 w-full rounded-md border border-border"
      aria-label="Map position of the location (drag the pin to adjust)"
    >
      <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
      <Recenter latitude={latitude} longitude={longitude} zoom={zoom} />
      <Marker position={[latitude, longitude]} draggable icon={pin} eventHandlers={handlers} />
    </MapContainer>
  );
}
