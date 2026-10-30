// Public build-time configuration. Only VITE_* variables reach the browser bundle; never put
// secrets in them.
export const APP_NAME = 'Surfaced';
export const API_BASE = (import.meta.env.VITE_API_URL ?? '/api/v1').replace(/\/$/, '');
export const SITE_URL = (import.meta.env.VITE_SITE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
export const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL ?? 'hello@surfaced.example';

export const absoluteUrl = (path: string): string => `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
