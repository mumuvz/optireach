import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { LocationEditor, emptyLocationDraft, type LocationDraft } from '@/components/local/location-editor';

// The draggable pin map is Leaflet-based and needs a real browser.
vi.mock('@/components/local/location-pin-map', () => ({ default: () => <div data-testid="pin-map" /> }));
import { applyPlaceFields, coordinatesFromMapsUrl } from '@/components/local/location-lookup';
import { mockFetch, renderWithProviders } from './utils';

describe('location lookup helpers', () => {
  it('reads coordinates from a Google Maps link, preferring the place pin', () => {
    expect(coordinatesFromMapsUrl('https://www.google.com/maps/place/X/@21.23,72.90,17z/data=!3d21.2311221!4d72.9033775')).toBe('21.2311221, 72.9033775'); // prettier-ignore
    expect(coordinatesFromMapsUrl('https://www.google.com/maps/@21.17,72.83,15z')).toBe('21.17, 72.83');
    expect(coordinatesFromMapsUrl('21.17, 72.83')).toBeNull();
  });

  it('fills the draft with what Google returned and keeps the rest', () => {
    const draft = emptyLocationDraft({ name: 'Old name', email: 'shop@example.test', city: 'Surat' });
    const next = applyPlaceFields(draft, {
      name: 'Rajmahel Jewellers',
      phone: '+91 99099 77695',
      latitude: 21.2185,
      longitude: 72.8892,
      placeId: 'ChIJ-rajmahel',
      openingHours: [
        { day: 'MONDAY', open: '10:30', close: '13:00' },
        { day: 'MONDAY', open: '14:00', close: '20:00' },
        { day: 'SUNDAY', open: '00:00', close: '24:00' },
      ],
    });
    expect(next).toMatchObject({ name: 'Rajmahel Jewellers', email: 'shop@example.test', city: 'Surat', coordinates: '21.2185, 72.8892', placeId: 'ChIJ-rajmahel' }); // prettier-ignore
    expect(next.hours.MONDAY).toEqual({ open: true, from: '10:30', to: '20:00' });
    expect(next.hours.SUNDAY).toEqual({ open: true, from: '00:00', to: '23:59' });
    expect(next.hours.TUESDAY.open).toBe(false);
  });
});

function Harness() {
  const [draft, setDraft] = useState<LocationDraft>(emptyLocationDraft({ city: 'Surat', country: 'IN' }));
  return (
    <>
      <LocationEditor value={draft} onChange={setDraft} workspaceId="w1" />
      <output data-testid="draft">{JSON.stringify(draft)}</output>
    </>
  );
}

describe('Fill from a Google link', () => {
  it('sends the link with the city and fills the form', async () => {
    document.cookie = 'sf_csrf=t';
    const calls = mockFetch({
      'POST /api/v1/workspaces/w1/places/from-google-link': {
        body: { data: { fields: { name: 'Rajmahel Jewellers', phone: '+91 99099 77695' }, filled: ['name', 'phone'], source: 'places_api', googleMapsUri: null, notes: ['Filled from Google Maps (Places API).'] } }, // prettier-ignore
      },
    });
    renderWithProviders(<Harness />);
    await userEvent.type(
      screen.getByLabelText(/Fill from a Google link/),
      'https://share.google/ebekx1ZVuwOS8qmLa',
    );
    await userEvent.click(screen.getByRole('button', { name: /Fill from link/ }));
    expect(await screen.findByText('Filled: name, phone')).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((c) => c.method === 'POST')!.init.body))).toEqual({ url: 'https://share.google/ebekx1ZVuwOS8qmLa', city: 'Surat', country: 'IN' }); // prettier-ignore
    await waitFor(() => expect(JSON.parse(screen.getByTestId('draft').textContent!)).toMatchObject({ name: 'Rajmahel Jewellers', phone: '+91 99099 77695' })); // prettier-ignore
  });
});
