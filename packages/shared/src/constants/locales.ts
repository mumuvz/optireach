// Locale constants shared by the web app and the API.
// Country codes follow ISO 3166-1 alpha-2; language tags follow BCP 47.
// Display names come from Intl.DisplayNames so they localize automatically.

const ISO_COUNTRY_CODES =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
  'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
  'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
  'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

/** All ISO 3166-1 alpha-2 country codes (249). */
export const COUNTRY_CODES: readonly string[] = Object.freeze(ISO_COUNTRY_CODES.split(' '));

const COUNTRY_CODE_SET = new Set(COUNTRY_CODES);

/** Markets shown first in pickers. Every entry must also be in COUNTRY_CODES. */
export const PRIORITY_COUNTRY_CODES: readonly string[] = Object.freeze([
  'US',
  'GB',
  'CA',
  'AU',
  'IN',
  'DE',
  'FR',
  'ES',
  'IT',
  'NL',
  'IE',
  'NZ',
  'SG',
  'AE',
  'BR',
  'MX',
  'JP',
  'ZA',
]);

/**
 * Supported content/prompt languages (BCP 47). Regional variants are included only where the
 * written language differs in practice (e.g. pt-BR vs pt, zh-CN vs zh-TW).
 */
export const LANGUAGE_CODES: readonly string[] = Object.freeze([
  'ar',
  'bg',
  'bn',
  'ca',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'en-GB',
  'en-US',
  'es',
  'es-MX',
  'et',
  'fa',
  'fi',
  'fil',
  'fr',
  'fr-CA',
  'he',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'lt',
  'lv',
  'ms',
  'nb',
  'nl',
  'pl',
  'pt',
  'pt-BR',
  'ro',
  'ru',
  'sk',
  'sl',
  'sr',
  'sv',
  'sw',
  'ta',
  'te',
  'th',
  'tr',
  'uk',
  'ur',
  'vi',
  'zh-CN',
  'zh-TW',
]);

const LANGUAGE_CODE_SET = new Set(LANGUAGE_CODES.map((code) => code.toLowerCase()));

export const PRIORITY_LANGUAGE_CODES: readonly string[] = Object.freeze([
  'en',
  'en-GB',
  'en-US',
  'es',
  'fr',
  'de',
  'pt-BR',
  'it',
  'nl',
  'hi',
  'ja',
]);

export function isCountryCode(value: string): boolean {
  return COUNTRY_CODE_SET.has(value);
}

/** Case-insensitive check; prefer `canonicalLanguageCode` before storing. */
export function isLanguageCode(value: string): boolean {
  return LANGUAGE_CODE_SET.has(value.toLowerCase());
}

/** Returns the canonical casing from LANGUAGE_CODES (e.g. "pt-br" → "pt-BR"), or null if unsupported. */
export function canonicalLanguageCode(value: string): string | null {
  const lower = value.trim().toLowerCase();
  return LANGUAGE_CODES.find((code) => code.toLowerCase() === lower) ?? null;
}

type DisplayNamesType = 'region' | 'language';
const displayNameCache = new Map<string, Intl.DisplayNames | null>();

function getDisplayNames(type: DisplayNamesType, locale: string): Intl.DisplayNames | null {
  const key = `${type}:${locale}`;
  if (!displayNameCache.has(key)) {
    try {
      displayNameCache.set(key, new Intl.DisplayNames([locale], { type, fallback: 'code' }));
    } catch {
      displayNameCache.set(key, null);
    }
  }
  return displayNameCache.get(key) ?? null;
}

export function countryName(code: string, locale = 'en'): string {
  return getDisplayNames('region', locale)?.of(code) ?? code;
}

export function languageName(code: string, locale = 'en'): string {
  return getDisplayNames('language', locale)?.of(code) ?? code;
}

export interface LocaleOption {
  code: string;
  name: string;
}

function sortOptions(codes: readonly string[], priority: readonly string[], nameOf: (c: string) => string) {
  const prioritySet = new Set(priority);
  const head = priority.map((code) => ({ code, name: nameOf(code) }));
  const tail = codes
    .filter((code) => !prioritySet.has(code))
    .map((code) => ({ code, name: nameOf(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...head, ...tail];
}

/** Country options for pickers: priority markets first, then alphabetical by display name. */
export function countryOptions(locale = 'en'): LocaleOption[] {
  return sortOptions(COUNTRY_CODES, PRIORITY_COUNTRY_CODES, (code) => countryName(code, locale));
}

/** Language options for pickers: common languages first, then alphabetical by display name. */
export function languageOptions(locale = 'en'): LocaleOption[] {
  return sortOptions(LANGUAGE_CODES, PRIORITY_LANGUAGE_CODES, (code) => languageName(code, locale));
}
