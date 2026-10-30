// AI search surfaces and manual observations. Each AI system is its own surface: Google AI Mode and AI Overviews are
// different features, and an API answer only approximates the consumer product, so they are never merged. A manual
// observation records what a person saw (pasted answer and links), labeled as manual with when and where it was seen.
import { z } from 'zod';
import { VISIBILITY_PROVIDERS, type CaptureMethod, type VisibilityProviderKey } from './enums';
import { countryCodeSchema, idSchema } from './schemas/common';

export const AI_SURFACES = [
  'GOOGLE_AI_MODE',
  'GOOGLE_AI_OVERVIEW',
  'CHATGPT',
  'GEMINI',
  'PERPLEXITY',
  'COPILOT',
  'CLAUDE',
  'OTHER',
] as const;
export type AiSurface = (typeof AI_SURFACES)[number];
export const AI_SURFACE_LABELS: Record<AiSurface, string> = {
  GOOGLE_AI_MODE: 'Google AI Mode',
  GOOGLE_AI_OVERVIEW: 'Google AI Overviews',
  CHATGPT: 'ChatGPT',
  GEMINI: 'Gemini app',
  PERPLEXITY: 'Perplexity',
  COPILOT: 'Microsoft Copilot',
  CLAUDE: 'Claude',
  OTHER: 'Other AI assistant',
};

/** Provider keys of manual observations, one per surface (stored in `ai_visibility_observations.provider`). */
export const MANUAL_PROVIDER_KEYS = [
  'manual_google_ai_mode',
  'manual_google_ai_overview',
  'manual_chatgpt',
  'manual_gemini',
  'manual_perplexity',
  'manual_copilot',
  'manual_claude',
  'manual_other',
] as const;
export type ManualProviderKey = (typeof MANUAL_PROVIDER_KEYS)[number];

export function manualProviderKey(surface: AiSurface): ManualProviderKey {
  return `manual_${surface.toLowerCase()}` as ManualProviderKey;
}

export function isManualProvider(provider: string): provider is ManualProviderKey {
  return (MANUAL_PROVIDER_KEYS as readonly string[]).includes(provider);
}

/** The surface an observation describes: manual entries name it; API providers that serve one surface map to it. */
export function surfaceOfProvider(provider: string): AiSurface | null {
  if (isManualProvider(provider)) return provider.slice('manual_'.length).toUpperCase() as AiSurface;
  if (provider === 'dataforseo_ai_mode') return 'GOOGLE_AI_MODE';
  return null;
}

/** Display label for any stored provider key, including manual ones and keys no longer offered. */
export function observationProviderLabel(provider: string): string {
  if (isManualProvider(provider))
    return `Manual observation · ${AI_SURFACE_LABELS[surfaceOfProvider(provider)!]}`;
  return VISIBILITY_PROVIDERS[provider as VisibilityProviderKey]?.label ?? provider;
}

export function captureMethodOfProvider(provider: string): CaptureMethod {
  if (isManualProvider(provider)) return 'MANUAL';
  if (provider === 'mock_demo') return 'DEMO';
  if (provider === 'dataforseo_ai_mode') return 'LICENSED_PROVIDER';
  return 'API';
}

/** City names: letters, spaces, dots, apostrophes and hyphens (as for keyword trends). */
export const citySchema = z
  .string()
  .trim()
  .max(120)
  .regex(/^\p{L}[\p{L} .'-]*$/u, 'Use the city name only');

export const manualObservationSchema = z.object({
  promptId: idSchema,
  surface: z.enum(AI_SURFACES),
  /** The answer as shown, copied from the AI system. */
  answerText: z.string().trim().min(20, 'Paste the whole answer').max(50_000),
  /** Links the answer showed as sources (one per line in the form). */
  citedUrls: z.array(z.url().max(2048)).max(50).default([]),
  observedAt: z.iso.datetime().optional(),
  /** Where the person was (defaults to the prompt's country and city). */
  country: countryCodeSchema.optional(),
  city: citySchema.nullable().optional(),
  /** Device, signed in or not, anything that may have changed the answer. */
  note: z.string().trim().max(1000).optional(),
});
export type ManualObservationInput = z.input<typeof manualObservationSchema>;
