// Google Trends' category list (id, name, parent path), retrieved once from Google's category picker and shipped
// with the app so the category filter needs no request to Google.
import data from './google-trends-categories.json';

export interface GoogleTrendsCategories {
  source: string;
  categories: [id: number, name: string, path: string][];
}

export function googleTrendsCategories(): GoogleTrendsCategories {
  return data as unknown as GoogleTrendsCategories;
}
