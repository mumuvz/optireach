import { googleOAuthConfigured } from './google';

export * from './google';
export * from './diagnostics';

export interface IntegrationCatalogEntry {
  provider:
    | 'GOOGLE_SEARCH_CONSOLE'
    | 'GOOGLE_BUSINESS_PROFILE'
    | 'GOOGLE_MERCHANT_CENTER'
    | 'GOOGLE_ANALYTICS_4'
    | 'WORDPRESS'
    | 'SHOPIFY';
  name: string;
  description: string;
  /** implemented: works when credentials are configured; planned: interface only, not yet usable. */
  availability: 'implemented' | 'planned';
  configured: boolean;
  setup: string;
}

/** Honest catalog: Search Console, Business Profile and Merchant Center are implemented; the rest are planned. */
export function integrationCatalog(): IntegrationCatalogEntry[] {
  return [
    {
      provider: 'GOOGLE_SEARCH_CONSOLE',
      name: 'Google Search Console',
      description: 'Import clicks, impressions, CTR and average position for a property you have access to.',
      availability: 'implemented',
      configured: googleOAuthConfigured(),
      setup:
        'Create an OAuth client in Google Cloud, enable the Search Console API, and set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and the redirect URI (docs/integrations.md).',
    },
    {
      provider: 'GOOGLE_BUSINESS_PROFILE',
      name: 'Google Business Profile',
      description:
        'Audit linked profiles, see searches, calls, direction requests and website clicks reported by Google, and reply to reviews after approval.',
      availability: 'implemented',
      configured: googleOAuthConfigured(),
      setup:
        'Uses the same Google OAuth client. Google must approve the Cloud project for Business Profile API access first (the quota is 0 until then), and the APIs must be enabled (docs/providers/google-business-profile.md).',
    },
    {
      provider: 'GOOGLE_MERCHANT_CENTER',
      name: 'Google Merchant Center',
      description:
        'Read products, their approval status and Google’s item issues, the free listings program and account issues. Read-only: Surfaced never changes Merchant Center data.',
      availability: 'implemented',
      configured: googleOAuthConfigured(),
      setup:
        'Uses the same Google OAuth client with the content scope. The OAuth app needs Google verification, and the Cloud project needs the one-time Merchant API developer registration (docs/providers/google-merchant-center.md).',
    },
    {
      provider: 'GOOGLE_ANALYTICS_4',
      name: 'Google Analytics 4',
      description: 'Planned: traffic and conversions from GA4 properties.',
      availability: 'planned',
      configured: false,
      setup: 'Not available yet. The integration interface is defined; no data is imported.',
    },
    {
      provider: 'WORDPRESS',
      name: 'WordPress',
      description: 'Planned: publish approved content to WordPress after explicit confirmation.',
      availability: 'planned',
      configured: false,
      setup: 'Not available yet. Content can be exported as Markdown or HTML today.',
    },
    {
      provider: 'SHOPIFY',
      name: 'Shopify',
      description: 'Planned: publish approved content to Shopify blogs after explicit confirmation.',
      availability: 'planned',
      configured: false,
      setup: 'Not available yet. Content can be exported as Markdown or HTML today.',
    },
  ];
}
