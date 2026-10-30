// Business Profile audit: explainable checks against Google's guidelines, each with the evidence found, a fix and a
// way to verify it. Only checks that apply to the business count (no website: the website check does not apply;
// service-area business: no street address is expected). Without a connected profile the audit reads the details
// entered in Surfaced and says so; checks that need Google's data are "unknown" and are not counted.
import type {
  BusinessProfile,
  LocationDto,
  ProfileAuditCheck,
  ProfileAuditDto,
  ProfileCheckSeverity,
  ProfileView,
} from '@surfaced/shared';

const GUIDELINES = 'https://support.google.com/business/answer/3038177';
const EDIT_PROFILE = 'https://support.google.com/business/answer/3039617';
const REVIEWS_HELP = 'https://support.google.com/business/answer/3474050';
const DESCRIPTION_MAX = 750;

export interface ProfileAuditInput {
  now: Date;
  location: Pick<
    LocationDto,
    | 'name'
    | 'kind'
    | 'primaryCategory'
    | 'secondaryCategories'
    | 'addressLine1'
    | 'city'
    | 'postalCode'
    | 'phone'
    | 'websiteUrl'
    | 'openingHours'
    | 'serviceAreas'
  >;
  /** The live profile; null audits the details entered in Surfaced. */
  profile: ProfileView | null;
  /** The business's website, when it has one. */
  website: { url: string; domain: string } | null;
  businessProfile: Pick<BusinessProfile, 'secondaryCategories'> | null;
  /** Reviews stored from the latest sync (null when not available). */
  reviews: { total: number; unanswered: number; oldestUnansweredAt: Date | null } | null;
}

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
/** Last 10 digits, so +91 98250 12345 and 098250 12345 compare equal. */
const phoneKey = (s: string | null | undefined) => digits(s).slice(-10);
const hostOf = (url: string | null | undefined) => {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return null;
  }
};
const norm = (s: string | null | undefined) =>
  (s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const NAME_PROBLEMS: { pattern: RegExp; what: string }[] = [
  { pattern: /https?:\/\/|www\.|\.(com|in|net|org|co)\b/i, what: 'a web address' },
  { pattern: /(\+?\d[\d\s-]{6,}\d)/, what: 'a phone number' },
  {
    pattern: /\b(best|top|no\.?\s?1|#1|number one|cheapest|cheap|lowest price|near me)\b/i,
    what: 'promotional words',
  },
  { pattern: /\b(open 24|24\s?x\s?7|24\/7|open now)\b/i, what: 'opening hours' },
];

function check(
  key: string,
  title: string,
  status: ProfileAuditCheck['status'],
  severity: ProfileCheckSeverity,
  evidence: string,
  extra: Partial<Pick<ProfileAuditCheck, 'recommendation' | 'verification' | 'reference'>> = {},
): ProfileAuditCheck {
  return {
    key,
    title,
    status,
    severity,
    evidence,
    recommendation: status === 'fail' ? (extra.recommendation ?? null) : null,
    verification: status === 'fail' ? (extra.verification ?? null) : null,
    reference: extra.reference ?? null,
  };
}

export function auditProfile(input: ProfileAuditInput): ProfileAuditDto {
  const { location, profile, website } = input;
  const live = profile !== null;
  const where = live ? 'on the Business Profile' : 'in the details entered here';
  const checks: ProfileAuditCheck[] = [];
  const name = live ? profile.title : location.name;
  const primaryCategory = live ? profile.primaryCategory : location.primaryCategory;
  const otherCategories = live ? profile.additionalCategories : location.secondaryCategories;
  const phone = live ? profile.primaryPhone : location.phone;
  const site = live ? profile.websiteUri : location.websiteUrl;
  const hours = live ? profile.regularHours : location.openingHours;
  const serviceOnly = live
    ? profile.serviceArea?.businessType === 'CUSTOMER_LOCATION_ONLY'
    : location.kind === 'SERVICE_AREA';
  const servesArea = live ? Boolean(profile.serviceArea?.businessType) : location.kind !== 'STOREFRONT';

  // ---- Status and ownership (live profile only).
  if (live) {
    checks.push(
      profile.hasVoiceOfMerchant === null
        ? check('ownership', 'Edits can go live', 'unknown', 'critical', 'Google did not report whether the account can publish edits.')
        : check('ownership', 'Edits can go live', profile.hasVoiceOfMerchant ? 'pass' : 'fail', 'critical',
            profile.hasVoiceOfMerchant ? 'The connected account has control of this profile (Voice of Merchant).' : 'Google reports that this account does not have Voice of Merchant: edits and replies will not go live.', {
              recommendation: 'Complete or renew verification for this profile in Business Profile, or connect the account that owns it.',
              verification: 'Sync again: the check passes once Google reports Voice of Merchant.',
              reference: EDIT_PROFILE,
            }), // prettier-ignore
    );
    checks.push(
      check('open_status', 'Shown as open', profile.openStatus === 'OPEN' ? 'pass' : profile.openStatus ? 'fail' : 'unknown',
        profile.openStatus === 'CLOSED_PERMANENTLY' ? 'critical' : 'warning',
        profile.openStatus ? `Google lists the business as ${profile.openStatus.toLowerCase().replace(/_/g, ' ')}.` : 'Google did not report the open status.', {
          recommendation: 'If the business is trading, mark it as open in Business Profile.',
          verification: 'Sync again and confirm the status is "open".',
          reference: EDIT_PROFILE,
        }), // prettier-ignore
    );
    if (profile.hasGoogleUpdated || profile.hasPendingEdits)
      checks.push(
        check('pending', 'No unreviewed changes', 'fail', 'warning',
          [profile.hasGoogleUpdated ? 'Google has changed some values on the live profile (from user suggestions or other sources).' : null, profile.hasPendingEdits ? 'Some edits are still under review by Google.' : null].filter(Boolean).join(' '), {
            recommendation: 'Open Business Profile and accept or correct the changes Google shows, so the live profile is what the business intends.',
            verification: 'Sync again: the check passes when Google reports no updates or pending edits.',
            reference: EDIT_PROFILE,
          }), // prettier-ignore
      );
    else
      checks.push(
        check(
          'pending',
          'No unreviewed changes',
          'pass',
          'warning',
          'No Google updates or pending edits reported.',
        ),
      );
  }

  // ---- Name.
  const nameIssues = NAME_PROBLEMS.filter((p) => p.pattern.test(name)).map((p) => p.what);
  checks.push(
    check('name', 'Business name is the real-world name', nameIssues.length ? 'fail' : 'pass', 'warning',
      nameIssues.length ? `"${name}" contains ${nameIssues.join(' and ')}.` : `"${name}"`, {
        recommendation: 'Use only the name customers see on the storefront, website and stationery. Google may suspend profiles whose names include extra keywords, locations, phone numbers or promotions.',
        verification: 'The name on the profile matches the signage and contains no extra words.',
        reference: GUIDELINES,
      }), // prettier-ignore
  );

  // ---- Categories.
  checks.push(
    check('primary_category', 'Primary category is set', primaryCategory ? 'pass' : 'fail', 'critical',
      primaryCategory ? `Primary category: ${primaryCategory}.` : `No primary category ${where}.`, {
        recommendation: 'Choose the most specific category that describes the whole business (for example "Jewelry store" rather than "Store").',
        verification: 'The category shows under the business name on Google Maps.',
        reference: GUIDELINES,
      }), // prettier-ignore
  );
  const declared = input.businessProfile?.secondaryCategories ?? [];
  if (declared.length) {
    const have = new Set([primaryCategory, ...otherCategories].map(norm));
    const missing = declared.filter((c) => !have.has(norm(c)));
    checks.push(
      check('other_categories', 'Other categories match what the business offers', missing.length ? 'fail' : 'pass', 'suggestion',
        missing.length ? `Categories the business listed in Surfaced but not ${where}: ${missing.join(', ')}.` : `All categories the business listed are present (${otherCategories.length} additional).`, {
          recommendation: 'Add the additional categories that describe a substantial part of the business, if Google offers them. Only add categories that are true for the business.',
          verification: 'The categories appear in Business Profile under "Business category".',
          reference: GUIDELINES,
        }), // prettier-ignore
    );
  } else
    checks.push(check('other_categories', 'Other categories match what the business offers', 'not_applicable', 'suggestion', 'The business did not list other categories, so there is nothing to compare.')); // prettier-ignore

  // ---- Description (live profile only; Surfaced does not store one).
  if (live) {
    const d = profile.description;
    const hasUrl = d ? /https?:\/\/|www\./i.test(d) : false;
    checks.push(
      check('description', 'Description is present and within the rules', !d || hasUrl || d.length > DESCRIPTION_MAX ? 'fail' : 'pass', d ? 'warning' : 'suggestion',
        !d ? 'The profile has no description.' : hasUrl ? 'The description contains a web address, which Google does not allow.' : d.length > DESCRIPTION_MAX ? `The description has ${d.length} characters; Google allows ${DESCRIPTION_MAX}.` : `${d.length} of ${DESCRIPTION_MAX} characters.`, {
          recommendation: !d ? 'Add a description of what the business offers, where, and what makes it different, without links or promotions.' : 'Remove web addresses and keep the description within 750 characters.',
          verification: 'The description appears in the "From the business" section of the profile.',
          reference: GUIDELINES,
        }), // prettier-ignore
    );
  }

  // ---- Contact details.
  checks.push(
    check('phone', 'Phone number is listed', phone ? 'pass' : 'fail', 'warning', phone ? `Phone: ${phone}.` : `No phone number ${where}.`, {
      recommendation: 'Add a phone number that reaches the business directly (a local number where possible).',
      verification: 'The call button appears on the profile.',
      reference: GUIDELINES,
    }), // prettier-ignore
  );
  if (live && location.phone && profile.primaryPhone) {
    const same = phoneKey(location.phone) === phoneKey(profile.primaryPhone);
    checks.push(
      check('nap_phone', 'Phone matches the business record', same ? 'pass' : 'fail', 'warning',
        same ? 'The profile phone matches the phone in Surfaced.' : `The profile shows ${profile.primaryPhone}; the business record says ${location.phone}.`, {
          recommendation: 'Use the same phone number everywhere the business is listed (profile, website, directories), or correct the business record.',
          verification: 'Both numbers match after the next sync.',
        }), // prettier-ignore
    );
  }

  // ---- Website (applies only when the business has one).
  if (!website)
    checks.push(check('website', 'Website is linked', 'not_applicable', 'warning', 'The business has no website, so this check does not apply and is not counted.')); // prettier-ignore
  else {
    const host = hostOf(site);
    const ok = host !== null && (host === website.domain || host.endsWith(`.${website.domain}`));
    checks.push(
      check('website', 'Website is linked', ok ? 'pass' : 'fail', 'warning',
        !site ? `No website ${where}; the business website is ${website.domain}.` : ok ? `Links to ${site}.` : `Links to ${site}, which is not on ${website.domain}.`, {
          recommendation: `Link the profile to ${website.url} (or the page for this location).`,
          verification: 'The website button on the profile opens the business website.',
          reference: GUIDELINES,
        }), // prettier-ignore
    );
  }

  // ---- Address or service area.
  if (serviceOnly)
    checks.push(check('address', 'Address customers can visit', 'not_applicable', 'critical', 'Service-area business: Google hides the address, so none is expected.')); // prettier-ignore
  else {
    const hasAddress = live ? Boolean(profile.address?.lines.length) : Boolean(location.addressLine1);
    checks.push(
      check('address', 'Address customers can visit', hasAddress ? 'pass' : 'fail', 'critical',
        hasAddress ? 'A street address is listed.' : `No street address ${where}.`, {
          recommendation: 'Add the exact street address where customers are served, or set the profile up as a service-area business if customers are not served there.',
          verification: 'The pin on Google Maps is at the entrance.',
          reference: GUIDELINES,
        }), // prettier-ignore
    );
    if (live && profile.address && location.postalCode && profile.address.postalCode) {
      const same = norm(location.postalCode) === norm(profile.address.postalCode);
      checks.push(
        check('nap_address', 'Address matches the business record', same ? 'pass' : 'fail', 'warning',
          same ? 'The postal code matches the business record.' : `The profile postal code is ${profile.address.postalCode}; the business record says ${location.postalCode}.`, {
            recommendation: 'Make the address the same on the profile, the website and directories, or correct the business record.',
            verification: 'Both addresses match after the next sync.',
          }), // prettier-ignore
      );
    }
  }
  if (servesArea) {
    const areas = live ? (profile.serviceArea?.places ?? []) : location.serviceAreas;
    checks.push(
      check('service_area', 'Service area is set', areas.length ? 'pass' : 'fail', 'warning',
        areas.length ? `Serves: ${areas.slice(0, 8).join(', ')}${areas.length > 8 ? '…' : ''}.` : `No service area ${where}.`, {
          recommendation: 'List the cities or postal codes the business serves (Google allows up to 20, within about two hours of the base).',
          verification: 'The service area is shaded on the map when the profile is opened.',
          reference: GUIDELINES,
        }), // prettier-ignore
    );
  }

  // ---- Hours.
  checks.push(
    check('hours', 'Opening hours are set', hours.length ? 'pass' : 'fail', 'warning',
      hours.length ? `${new Set(hours.map((h) => h.day)).size} days with opening hours.` : `No opening hours ${where}.`, {
        recommendation: 'Add regular opening hours, and special hours before holidays, so customers do not arrive when the business is closed.',
        verification: 'The hours show on the profile with "Open" or "Closed" at the current time.',
        reference: GUIDELINES,
      }), // prettier-ignore
  );

  // ---- Reviews (from the latest sync).
  if (input.reviews) {
    const r = input.reviews;
    const days = r.oldestUnansweredAt ? Math.floor((input.now.getTime() - r.oldestUnansweredAt.getTime()) / 86_400_000) : null;
    checks.push(
      r.total === 0
        ? check('review_replies', 'Reviews are answered', 'not_applicable', 'warning', 'No reviews were returned for this profile.')
        : check('review_replies', 'Reviews are answered', r.unanswered ? 'fail' : 'pass', 'warning',
            r.unanswered ? `${r.unanswered} of the ${r.total} most recent reviews have no reply${days !== null ? `; the oldest is ${days} days old` : ''}.` : `All ${r.total} recent reviews have a reply.`, {
              recommendation: 'Reply to reviews, especially critical ones, with a specific and polite answer. Replies are public.',
              verification: 'After publishing, the reply shows under the review on Google.',
              reference: REVIEWS_HELP,
            }), // prettier-ignore
    );
  } else if (live)
    checks.push(check('review_replies', 'Reviews are answered', 'unknown', 'warning', 'Reviews have not been synced yet.')); // prettier-ignore
  else checks.push(check('review_replies', 'Reviews are answered', 'unknown', 'warning', 'Connect Business Profile to check reviews and replies.')); // prettier-ignore

  if (!live)
    for (const [key, title] of [
      ['ownership', 'Edits can go live'],
      ['description', 'Description is present and within the rules'],
    ] as const)
      checks.unshift(check(key, title, 'unknown', 'warning', 'Needs a connected Business Profile.'));

  const counted = checks.filter((c) => c.status === 'pass' || c.status === 'fail');
  const order: Record<ProfileAuditCheck['status'], number> = {
    fail: 0,
    unknown: 1,
    pass: 2,
    not_applicable: 3,
  };
  const rank: Record<ProfileCheckSeverity, number> = { critical: 0, warning: 1, suggestion: 2 };
  checks.sort((a, b) => order[a.status] - order[b.status] || rank[a.severity] - rank[b.severity]);
  return {
    source: live ? 'BUSINESS_PROFILE' : 'MANUAL',
    checkedAt: input.now.toISOString(),
    applicable: counted.length,
    passed: counted.filter((c) => c.status === 'pass').length,
    checks,
    limitations: [
      live
        ? 'Checks the profile as Google returned it at the last sync; Google may show slightly different values to searchers.'
        : 'Based on the details entered in Surfaced, not the live Google profile. Connect Business Profile to audit the profile itself.',
      'Checks follow Google’s published guidelines; passing them does not guarantee rankings.',
    ],
  };
}
