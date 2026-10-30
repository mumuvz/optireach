/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API base path or URL, e.g. "/api/v1" (same-origin) or "https://api.example.com/api/v1". */
  readonly VITE_API_URL?: string;
  /** Public site origin used for canonical URLs, Open Graph and the sitemap. */
  readonly VITE_SITE_URL?: string;
  readonly VITE_CONTACT_EMAIL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
