// Projects can describe businesses without a website (local businesses managed through their listings). Features
// that read the website (audits, crawls, SEO comparison, competitor gap checks) call requireWebsite first and refuse
// clearly; everything else works from the business name and listings.

export class NoWebsiteError extends Error {
  constructor(readonly feature: string) {
    super(
      `${feature} needs a website, and this business has none yet. Add the website in project settings to use it.`,
    );
    this.name = 'NoWebsiteError';
  }
}

export function hasWebsite<T extends { websiteUrl: string | null; domain: string | null }>(
  project: T,
): project is T & { websiteUrl: string; domain: string } {
  return Boolean(project.websiteUrl && project.domain);
}

export function requireWebsite<T extends { websiteUrl: string | null; domain: string | null }>(
  project: T,
  feature: string,
): T & { websiteUrl: string; domain: string } {
  if (!hasWebsite(project)) throw new NoWebsiteError(feature);
  return project;
}
