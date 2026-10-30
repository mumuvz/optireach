// Surfaced's checks of product data against Google's product data specification. Each issue names the programs it
// affects (free listings, Shopping ads, free local listings) and, where rules differ by country, the country. These
// are predictions from the data; Merchant Center's own item issues (when connected) are what Google decided.
import {
  APPAREL_STRICT_COUNTRIES,
  COUNTRY_CURRENCY,
  PRODUCT_AVAILABILITY,
  PRODUCT_CONDITIONS,
  type ProductData,
  type ProductIssue,
  type ProductIssueSeverity,
  type ProductProgram,
} from '@surfaced/shared';

const SPEC = 'https://support.google.com/merchants/answer/7052112';
const ONLINE: ProductProgram[] = ['FREE_LISTINGS', 'SHOPPING_ADS'];
const ALL: ProductProgram[] = ['FREE_LISTINGS', 'SHOPPING_ADS', 'FREE_LOCAL_LISTINGS'];

export interface ProductCheckContext {
  /** Country the product data targets (feed label). */
  country: string;
  /** The business website's domain; landing pages should be on it. Null when the business has no website. */
  websiteDomain: string | null;
}

/** GTIN-8, -12, -13 or -14 with a valid check digit. */
export function isValidGtin(gtin: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(gtin)) return false;
  const digits = gtin.split('').map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((s, d, i) => s + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

const APPAREL_IDS = new Set(['166', '1604', '187', '188', '167', '178', '184', '5181', '200', '196', '194', '191', '192', '197']); // prettier-ignore
const CLOTHING_OR_SHOES_IDS = new Set(['1604', '187']);
const JEWELRY_IDS = new Set(['188', '200', '196', '194', '191', '192', '197']);

function categoryOf(p: ProductData) {
  const c = (p.googleProductCategory ?? '').trim();
  const text = c.toLowerCase();
  const id = /^\d+$/.test(c) ? c : null;
  return {
    apparel: (id !== null && APPAREL_IDS.has(id)) || text.startsWith('apparel & accessories'),
    clothingOrShoes:
      (id !== null && CLOTHING_OR_SHOES_IDS.has(id)) ||
      /^apparel & accessories > (clothing|shoes)/.test(text),
    jewelry: (id !== null && JEWELRY_IDS.has(id)) || text.includes('jewelry') || text.includes('jewellery'),
  };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

const PROMO =
  /\b(free shipping|free delivery|sale|discount|\d+% off|best price|lowest price|buy now|limited offer|offer)\b/i;
const COUNTERFEIT = /\b(replica|counterfeit|knock[- ]?off|fake|dupe|first copy|1st copy|master copy)\b/i;

export function validateProduct(p: ProductData, ctx: ProductCheckContext): ProductIssue[] {
  const issues: ProductIssue[] = [];
  const add = (
    code: string,
    severity: ProductIssueSeverity,
    attribute: string | null,
    message: string,
    fix: string | null,
    programs: ProductProgram[] = ONLINE,
    countries: string[] = [],
  ) =>
    issues.push({
      code,
      severity,
      attribute,
      message,
      fix,
      programs,
      source: 'SURFACED',
      countries,
      documentation: SPEC,
    });
  const category = categoryOf(p);

  // ---- Required basics.
  if (!p.title)
    add(
      'missing_title',
      'error',
      'title',
      'No title.',
      'Add the product name as customers know it (up to 150 characters).',
      ALL,
    );
  else {
    if (p.title.length > 150) add('title_too_long', 'error', 'title', `The title has ${p.title.length} characters; Google allows 150.`, 'Shorten the title; put details in the description.', ALL); // prettier-ignore
    if (PROMO.test(p.title)) add('title_promotional', 'warning', 'title', 'The title contains promotional text.', 'Remove offers and shipping claims from the title; use sale price and shipping settings instead.', ALL); // prettier-ignore
    if (p.title.length >= 12 && p.title === p.title.toUpperCase() && /[A-Z]/.test(p.title)) add('title_all_caps', 'warning', 'title', 'The title is written in capital letters.', 'Use normal capitalization.', ALL); // prettier-ignore
    if (p.brand && !p.title.toLowerCase().includes(p.brand.toLowerCase()) && p.title.length < 120) add('title_without_brand', 'suggestion', 'title', 'The title does not mention the brand.', 'Start the title with the brand if shoppers search for it.', ONLINE); // prettier-ignore
  }
  if (!p.description)
    add('missing_description', 'error', 'description', 'No description.', 'Describe the product: what it is, material, size and what it is for.', ALL); // prettier-ignore
  else {
    if (p.description.length > 5000) add('description_too_long', 'error', 'description', `The description has ${p.description.length} characters; Google allows 5,000.`, 'Shorten the description.', ALL); // prettier-ignore
    if (p.title && p.description.trim().toLowerCase() === p.title.trim().toLowerCase()) add('description_same_as_title', 'warning', 'description', 'The description repeats the title.', 'Describe features, materials and use.', ALL); // prettier-ignore
  }
  const text = `${p.title ?? ''} ${p.description ?? ''}`;
  if (COUNTERFEIT.test(text)) add('counterfeit_wording', 'error', 'title', `The text contains "${text.match(COUNTERFEIT)![0]}", which Google treats as a sign of counterfeit goods; this can suspend the account.`, 'Remove the wording. Sell only genuine products under their own brand.', ALL); // prettier-ignore
  else if (/\bimitation\b/i.test(text)) add('imitation_wording', 'suggestion', 'title', 'The text says "imitation".', 'For fashion jewellery, "fashion jewellery" or "artificial jewellery" is clearer; never combine "imitation" with another brand’s name.', ALL); // prettier-ignore

  // ---- Landing page and images.
  if (!p.link)
    add('missing_link', 'error', 'link', ctx.websiteDomain ? 'No landing page link.' : 'No landing page link: the business has no website.', ctx.websiteDomain ? `Link each product to its page on ${ctx.websiteDomain}.` : 'Online listings need a product page on a website you own. Without one, products can only use free local listings (in-store products).', ONLINE); // prettier-ignore
  else if (!/^https?:\/\//i.test(p.link))
    add('invalid_link', 'error', 'link', 'The link is not a web address.', 'Use the full product page URL starting with https://.', ONLINE); // prettier-ignore
  else {
    const host = hostOf(p.link);
    if (ctx.websiteDomain && host && host !== ctx.websiteDomain && !host.endsWith(`.${ctx.websiteDomain}`))
      add('link_other_domain', 'warning', 'link', `The link goes to ${host}, not the business website ${ctx.websiteDomain}.`, 'Landing pages must be on the website claimed in Merchant Center.', ONLINE); // prettier-ignore
    if (p.link.startsWith('http://')) add('link_not_https', 'suggestion', 'link', 'The link uses http, not https.', 'Use https landing pages.', ONLINE); // prettier-ignore
  }
  if (!p.imageLink) add('missing_image', 'error', 'image_link', 'No image.', 'Add a clear photo of the product on a plain background, at least 500 × 500 pixels.', ALL); // prettier-ignore
  else if (!/^https?:\/\//i.test(p.imageLink)) add('invalid_image_link', 'error', 'image_link', 'The image link is not a web address.', 'Use the full image URL.', ALL); // prettier-ignore
  if (p.imageLink && !p.additionalImageLinks.length) add('single_image', 'suggestion', 'additional_image_link', 'Only one image.', 'Add more views (side, worn, detail) as additional images.', ONLINE); // prettier-ignore

  // ---- Price and currency.
  const currency = COUNTRY_CURRENCY[ctx.country];
  if (!p.price)
    add(
      'missing_price',
      'error',
      'price',
      'No price.',
      'Add the price with its currency, for example "1499.00 INR".',
      ALL,
    );
  else {
    if (p.price.amount <= 0)
      add(
        'invalid_price',
        'error',
        'price',
        'The price is zero or negative.',
        'Use the real selling price.',
        ALL,
      );
    if (currency && p.price.currency !== currency)
      add('currency_mismatch', 'error', 'price', `The price is in ${p.price.currency}, but products sold in ${ctx.country} need ${currency}.`, `Submit prices in ${currency}, or set up currency conversion in Merchant Center.`, ALL, [ctx.country]); // prettier-ignore
    if (p.salePrice && p.salePrice.amount >= p.price.amount) add('sale_price_not_lower', 'error', 'sale_price', 'The sale price is not lower than the price.', 'Remove the sale price or correct it.', ALL); // prettier-ignore
  }

  // ---- Availability and condition.
  if (!p.availability) add('missing_availability', 'error', 'availability', 'No availability.', 'Use in_stock, out_of_stock, preorder or backorder.', ALL); // prettier-ignore
  else if (!(PRODUCT_AVAILABILITY as readonly string[]).includes(p.availability)) add('invalid_availability', 'error', 'availability', `"${p.availability}" is not a valid availability.`, 'Use in_stock, out_of_stock, preorder or backorder.', ALL); // prettier-ignore
  if (p.condition && !(PRODUCT_CONDITIONS as readonly string[]).includes(p.condition)) add('invalid_condition', 'error', 'condition', `"${p.condition}" is not a valid condition.`, 'Use new, refurbished or used.', ALL); // prettier-ignore

  // ---- Identifiers.
  if (!p.brand && p.identifierExists !== false) add('missing_brand', 'warning', 'brand', 'No brand.', 'Use the manufacturer’s brand; for your own or handmade products, use the store name.', ONLINE); // prettier-ignore
  for (const g of p.gtins)
    if (!isValidGtin(g)) add('invalid_gtin', 'error', 'gtin', `"${g}" is not a valid GTIN (length or check digit).`, 'Use the barcode number exactly as printed, or remove it. Never make one up.', ONLINE); // prettier-ignore
  if (!p.gtins.length && !p.mpn && p.identifierExists !== false)
    add('missing_identifiers', 'warning', 'gtin', 'No GTIN, no MPN, and identifier_exists is not set to no.', 'Add the GTIN if the product has one. For custom or handmade pieces, set identifier_exists to no (and use the store as brand).', ONLINE); // prettier-ignore

  // ---- Apparel and jewellery.
  const strict = (APPAREL_STRICT_COUNTRIES as readonly string[]).includes(ctx.country);
  if (category.apparel) {
    const missing = [
      ['color', p.color],
      ['gender', p.gender],
      ['age_group', p.ageGroup],
      ...(category.clothingOrShoes ? [['size', p.size] as const] : []),
    ]
      .filter(([, v]) => !v)
      .map(([n]) => n as string);
    if (missing.length)
      add('apparel_attributes', strict ? 'error' : 'suggestion', missing[0]!, `Apparel without ${missing.join(', ')}.`,
        strict ? `Required for apparel sold in ${ctx.country}: add ${missing.join(', ')}.` : 'Recommended for apparel; required if you also sell in Brazil, France, Germany, Japan, the UK or the US.',
        strict ? ALL : ONLINE, strict ? [ctx.country] : []); // prettier-ignore
  }
  if (category.jewelry && !p.material) add('jewelry_material', 'suggestion', 'material', 'No material.', 'Add the metal or material, for example "22k gold" or "sterling silver", only as the piece really is.', ONLINE); // prettier-ignore
  if ((p.size || p.color) && !p.itemGroupId && category.apparel) add('missing_item_group', 'suggestion', 'item_group_id', 'A size or colour variant without an item group.', 'Give all variants of one product the same item_group_id.', ONLINE); // prettier-ignore
  if (!p.googleProductCategory) add('missing_category', 'suggestion', 'google_product_category', 'No Google product category.', 'Google assigns one automatically; set it when the automatic category is wrong.', ONLINE); // prettier-ignore
  return issues;
}

export function summarizeIssues(issues: ProductIssue[]) {
  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;
  return {
    errorCount,
    warningCount,
    status: (errorCount ? 'errors' : warningCount ? 'warnings' : 'ok') as 'ok' | 'warnings' | 'errors',
  };
}
