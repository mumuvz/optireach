// Industry options for customer projects. Stored as the `key` (a stable slug) in projects.industry.

export interface IndustryOption {
  key: string;
  label: string;
}

export const INDUSTRIES: readonly IndustryOption[] = Object.freeze([
  { key: 'saas', label: 'Software & SaaS' },
  { key: 'ecommerce', label: 'E-commerce & retail' },
  { key: 'agency', label: 'Marketing & creative agency' },
  { key: 'professional-services', label: 'Professional services' },
  { key: 'finance', label: 'Finance & insurance' },
  { key: 'fintech', label: 'Fintech' },
  { key: 'healthcare', label: 'Healthcare & medical' },
  { key: 'wellness', label: 'Health, fitness & wellness' },
  { key: 'education', label: 'Education & e-learning' },
  { key: 'real-estate', label: 'Real estate' },
  { key: 'legal', label: 'Legal services' },
  { key: 'travel', label: 'Travel & hospitality' },
  { key: 'food', label: 'Food & beverage' },
  { key: 'restaurants', label: 'Restaurants & local dining' },
  { key: 'home-services', label: 'Home & local services' },
  { key: 'automotive', label: 'Automotive' },
  { key: 'manufacturing', label: 'Manufacturing & industrial' },
  { key: 'logistics', label: 'Logistics & supply chain' },
  { key: 'construction', label: 'Construction & architecture' },
  { key: 'energy', label: 'Energy & utilities' },
  { key: 'telecom', label: 'Telecommunications' },
  { key: 'media', label: 'Media & publishing' },
  { key: 'entertainment', label: 'Entertainment & gaming' },
  { key: 'fashion', label: 'Fashion & apparel' },
  { key: 'beauty', label: 'Beauty & personal care' },
  { key: 'consumer-electronics', label: 'Consumer electronics' },
  { key: 'b2b-services', label: 'B2B services' },
  { key: 'hr-recruiting', label: 'HR & recruiting' },
  { key: 'nonprofit', label: 'Nonprofit & community' },
  { key: 'government', label: 'Government & public sector' },
  { key: 'other', label: 'Other' },
]);

export const INDUSTRY_KEYS: readonly string[] = Object.freeze(INDUSTRIES.map((i) => i.key));

const INDUSTRY_BY_KEY = new Map(INDUSTRIES.map((i) => [i.key, i]));

export function isIndustryKey(value: string): boolean {
  return INDUSTRY_BY_KEY.has(value);
}

export function industryLabel(key: string | null | undefined): string {
  if (!key) return 'Not specified';
  return INDUSTRY_BY_KEY.get(key)?.label ?? key;
}
