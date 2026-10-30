// Sub-regions offered in the Keyword trends filters. Codes are the ones Google Trends itself uses (ISO 3166-2, with
// Google's older codes for some Indian states such as IN-CT and IN-OR). Other countries accept any ISO 3166-2 code.

export interface TrendRegionOption {
  code: string;
  name: string;
}

const INDIA: [string, string][] = [
  ['IN-AN', 'Andaman and Nicobar Islands'], ['IN-AP', 'Andhra Pradesh'], ['IN-AR', 'Arunachal Pradesh'],
  ['IN-AS', 'Assam'], ['IN-BR', 'Bihar'], ['IN-CH', 'Chandigarh'], ['IN-CT', 'Chhattisgarh'],
  ['IN-DN', 'Dadra and Nagar Haveli'], ['IN-DD', 'Daman and Diu'], ['IN-DL', 'Delhi'], ['IN-GA', 'Goa'],
  ['IN-GJ', 'Gujarat'], ['IN-HR', 'Haryana'], ['IN-HP', 'Himachal Pradesh'], ['IN-JK', 'Jammu and Kashmir'],
  ['IN-JH', 'Jharkhand'], ['IN-KA', 'Karnataka'], ['IN-KL', 'Kerala'], ['IN-LD', 'Lakshadweep'],
  ['IN-MP', 'Madhya Pradesh'], ['IN-MH', 'Maharashtra'], ['IN-MN', 'Manipur'], ['IN-ML', 'Meghalaya'],
  ['IN-MZ', 'Mizoram'], ['IN-NL', 'Nagaland'], ['IN-OR', 'Odisha'], ['IN-PY', 'Puducherry'], ['IN-PB', 'Punjab'],
  ['IN-RJ', 'Rajasthan'], ['IN-SK', 'Sikkim'], ['IN-TN', 'Tamil Nadu'], ['IN-TG', 'Telangana'], ['IN-TR', 'Tripura'],
  ['IN-UP', 'Uttar Pradesh'], ['IN-UT', 'Uttarakhand'], ['IN-WB', 'West Bengal'],
]; // prettier-ignore

const UNITED_STATES: [string, string][] = [
  ['US-AL', 'Alabama'], ['US-AK', 'Alaska'], ['US-AZ', 'Arizona'], ['US-AR', 'Arkansas'], ['US-CA', 'California'],
  ['US-CO', 'Colorado'], ['US-CT', 'Connecticut'], ['US-DE', 'Delaware'], ['US-DC', 'District of Columbia'],
  ['US-FL', 'Florida'], ['US-GA', 'Georgia'], ['US-HI', 'Hawaii'], ['US-ID', 'Idaho'], ['US-IL', 'Illinois'],
  ['US-IN', 'Indiana'], ['US-IA', 'Iowa'], ['US-KS', 'Kansas'], ['US-KY', 'Kentucky'], ['US-LA', 'Louisiana'],
  ['US-ME', 'Maine'], ['US-MD', 'Maryland'], ['US-MA', 'Massachusetts'], ['US-MI', 'Michigan'],
  ['US-MN', 'Minnesota'], ['US-MS', 'Mississippi'], ['US-MO', 'Missouri'], ['US-MT', 'Montana'],
  ['US-NE', 'Nebraska'], ['US-NV', 'Nevada'], ['US-NH', 'New Hampshire'], ['US-NJ', 'New Jersey'],
  ['US-NM', 'New Mexico'], ['US-NY', 'New York'], ['US-NC', 'North Carolina'], ['US-ND', 'North Dakota'],
  ['US-OH', 'Ohio'], ['US-OK', 'Oklahoma'], ['US-OR', 'Oregon'], ['US-PA', 'Pennsylvania'],
  ['US-RI', 'Rhode Island'], ['US-SC', 'South Carolina'], ['US-SD', 'South Dakota'], ['US-TN', 'Tennessee'],
  ['US-TX', 'Texas'], ['US-UT', 'Utah'], ['US-VT', 'Vermont'], ['US-VA', 'Virginia'], ['US-WA', 'Washington'],
  ['US-WV', 'West Virginia'], ['US-WI', 'Wisconsin'], ['US-WY', 'Wyoming'],
]; // prettier-ignore

const REGIONS: Record<string, [string, string][]> = { IN: INDIA, US: UNITED_STATES };

/** Known sub-regions of a country (empty when the country has no built-in list; any ISO 3166-2 code still works). */
export function trendRegionOptions(country: string | null | undefined): TrendRegionOption[] {
  return (country ? (REGIONS[country.toUpperCase()] ?? []) : []).map(([code, name]) => ({ code, name }));
}

export function trendRegionName(code: string | null | undefined): string | null {
  if (!code) return null;
  const country = code.slice(0, 2).toUpperCase();
  return REGIONS[country]?.find(([c]) => c === code.toUpperCase())?.[1] ?? code.toUpperCase();
}

// ---------------- Cities ----------------
// Google Trends cannot filter to a city outside US metro areas, and its city breakdown returns no data for India
// through the endpoints available to us (checked live on 2026-10-23). The city filter therefore compares searches
// that mention the city ("wedding card surat"), measured in the city's state. Cities below map to Google's state
// codes; any other city name can be typed.

const INDIAN_CITIES: [string, string][] = [
  ['Agra', 'IN-UP'], ['Ahmedabad', 'IN-GJ'], ['Ajmer', 'IN-RJ'], ['Amritsar', 'IN-PB'], ['Aurangabad', 'IN-MH'],
  ['Bengaluru', 'IN-KA'], ['Bhavnagar', 'IN-GJ'], ['Bhopal', 'IN-MP'], ['Bhubaneswar', 'IN-OR'], ['Chandigarh', 'IN-CH'],
  ['Chennai', 'IN-TN'], ['Coimbatore', 'IN-TN'], ['Dehradun', 'IN-UT'], ['Delhi', 'IN-DL'], ['Faridabad', 'IN-HR'],
  ['Gandhinagar', 'IN-GJ'], ['Ghaziabad', 'IN-UP'], ['Gurugram', 'IN-HR'], ['Guwahati', 'IN-AS'], ['Gwalior', 'IN-MP'],
  ['Hubballi', 'IN-KA'], ['Hyderabad', 'IN-TG'], ['Indore', 'IN-MP'], ['Jabalpur', 'IN-MP'], ['Jaipur', 'IN-RJ'],
  ['Jalandhar', 'IN-PB'], ['Jamnagar', 'IN-GJ'], ['Jodhpur', 'IN-RJ'], ['Kanpur', 'IN-UP'], ['Kochi', 'IN-KL'],
  ['Kolkata', 'IN-WB'], ['Kota', 'IN-RJ'], ['Lucknow', 'IN-UP'], ['Ludhiana', 'IN-PB'], ['Madurai', 'IN-TN'],
  ['Mangaluru', 'IN-KA'], ['Meerut', 'IN-UP'], ['Mumbai', 'IN-MH'], ['Mysuru', 'IN-KA'], ['Nagpur', 'IN-MH'],
  ['Nashik', 'IN-MH'], ['Navi Mumbai', 'IN-MH'], ['Noida', 'IN-UP'], ['Panaji', 'IN-GA'], ['Patna', 'IN-BR'],
  ['Prayagraj', 'IN-UP'], ['Pune', 'IN-MH'], ['Raipur', 'IN-CT'], ['Rajkot', 'IN-GJ'], ['Ranchi', 'IN-JH'],
  ['Srinagar', 'IN-JK'], ['Surat', 'IN-GJ'], ['Thane', 'IN-MH'], ['Thiruvananthapuram', 'IN-KL'],
  ['Tiruchirappalli', 'IN-TN'], ['Udaipur', 'IN-RJ'], ['Vadodara', 'IN-GJ'], ['Varanasi', 'IN-UP'],
  ['Vijayawada', 'IN-AP'], ['Visakhapatnam', 'IN-AP'],
]; // prettier-ignore

const US_CITIES: [string, string][] = [
  ['Atlanta', 'US-GA'], ['Austin', 'US-TX'], ['Boston', 'US-MA'], ['Chicago', 'US-IL'], ['Dallas', 'US-TX'],
  ['Denver', 'US-CO'], ['Houston', 'US-TX'], ['Las Vegas', 'US-NV'], ['Los Angeles', 'US-CA'], ['Miami', 'US-FL'],
  ['New York', 'US-NY'], ['Philadelphia', 'US-PA'], ['Phoenix', 'US-AZ'], ['San Antonio', 'US-TX'],
  ['San Diego', 'US-CA'], ['San Francisco', 'US-CA'], ['San Jose', 'US-CA'], ['Seattle', 'US-WA'],
]; // prettier-ignore

const CITIES: Record<string, [string, string][]> = { IN: INDIAN_CITIES, US: US_CITIES };

export interface TrendCityOption {
  name: string;
  /** The state or region the city is in (Google's code). */
  region: string;
}

/** Known cities of a country, optionally only those in one region. */
export function trendCityOptions(
  country: string | null | undefined,
  region?: string | null,
): TrendCityOption[] {
  return (country ? (CITIES[country.toUpperCase()] ?? []) : [])
    .filter(([, r]) => !region || r === region.toUpperCase())
    .map(([name, r]) => ({ name, region: r }));
}

/** The region of a known city ("Surat" in IN → "IN-GJ"), or null for cities not in the list. */
export function trendCityRegion(
  country: string | null | undefined,
  city: string | null | undefined,
): string | null {
  if (!country || !city) return null;
  const c = city.trim().toLowerCase();
  return CITIES[country.toUpperCase()]?.find(([name]) => name.toLowerCase() === c)?.[1] ?? null;
}

/** "wedding card" + "Surat" → "wedding card surat" (unchanged when the term already names the city). */
export function termWithCity(term: string, city: string | null | undefined): string {
  if (!city) return term;
  const c = city.trim().toLowerCase();
  return term.toLowerCase().includes(c) ? term : `${term.trim()} ${c}`.slice(0, 100);
}
