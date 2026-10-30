// Product feed files: Google's product data format (CSV or TSV, attribute names as column headers) and Shopify's
// product export. Values are read as given; nothing is inferred except the price currency when the file omits it
// (taken from the selected country and listed as a limitation).
import {
  COUNTRY_CURRENCY,
  PRODUCT_FEED_MAX_ROWS,
  type Money,
  type ProductData,
  type ProductFeedPreviewDto,
} from '@surfaced/shared';

/** RFC 4180 parsing: quoted fields may contain the delimiter, doubled quotes and line breaks. */
export function parseDelimited(content: string, delimiter: ',' | '\t'): string[][] {
  const text = content.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(content: string): ',' | '\t' {
  const firstLine = content.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  return (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : ',';
}

const key = (header: string) =>
  header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_()]/g, '');

/** Google attribute (column) names and common variants, to the field they fill. */
const GOOGLE_COLUMNS: Record<
  string,
  keyof ProductData | 'feed_price' | 'feed_sale_price' | 'product_detail'
> = {
  id: 'offerId',
  offer_id: 'offerId',
  title: 'title',
  description: 'description',
  link: 'link',
  image_link: 'imageLink',
  additional_image_link: 'additionalImageLinks',
  price: 'feed_price',
  sale_price: 'feed_sale_price',
  availability: 'availability',
  condition: 'condition',
  brand: 'brand',
  gtin: 'gtins',
  mpn: 'mpn',
  identifier_exists: 'identifierExists',
  google_product_category: 'googleProductCategory',
  product_type: 'productTypes',
  item_group_id: 'itemGroupId',
  color: 'color',
  colour: 'color',
  material: 'material',
  pattern: 'pattern',
  size: 'size',
  gender: 'gender',
  age_group: 'ageGroup',
  product_detail: 'product_detail',
};

/** Shopify product export columns (one row per variant; product fields only on the first row of a handle). */
const SHOPIFY_COLUMNS: Record<string, string> = {
  handle: 'handle',
  title: 'title',
  'body_(html)': 'description',
  vendor: 'brand',
  type: 'productTypes',
  product_category: 'googleProductCategory',
  variant_sku: 'offerId',
  variant_price: 'feed_price',
  variant_compare_at_price: 'compare_at',
  variant_barcode: 'gtins',
  image_src: 'imageLink',
  variant_image: 'variantImage',
  variant_inventory_qty: 'inventory',
  option1_name: 'o1n',
  option1_value: 'o1v',
  option2_name: 'o2n',
  option2_value: 'o2v',
  option3_name: 'o3n',
  option3_value: 'o3v',
  status: 'status',
  published: 'published',
};

const CURRENCY_SYMBOLS: Record<string, string> = { '₹': 'INR', $: 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY' };

/** "1,500.00 INR", "INR 1500", "₹1,500" or "1500" (currency then comes from the country). */
export function parsePrice(
  raw: string,
  defaultCurrency: string | null,
): { money: Money | null; assumedCurrency: boolean } {
  const text = raw.trim();
  if (!text) return { money: null, assumedCurrency: false };
  const code = text.match(/\b([A-Za-z]{3})\b/)?.[1]?.toUpperCase() ?? null;
  const symbol = Object.keys(CURRENCY_SYMBOLS).find((s) => text.includes(s));
  const number = text.replace(/[^\d.,-]/g, '');
  // "1.500,00" (comma decimals) versus "1,500.00".
  const normalized = /,\d{1,2}$/.test(number) && !/\.\d{1,2}$/.test(number) ? number.replace(/\./g, '').replace(',', '.') : number.replace(/,/g, ''); // prettier-ignore
  const amount = Number(normalized);
  if (!normalized || !Number.isFinite(amount)) return { money: null, assumedCurrency: false };
  const currency = code ?? (symbol ? CURRENCY_SYMBOLS[symbol]! : defaultCurrency);
  if (!currency) return { money: null, assumedCurrency: false };
  return { money: { amount: Math.round(amount * 100) / 100, currency }, assumedCurrency: !code && !symbol };
}

const list = (v: string) =>
  v
    .split(/\s*[,|]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);

const AVAILABILITY_ALIASES: Record<string, string> = {
  in_stock: 'in_stock',
  instock: 'in_stock',
  'in stock': 'in_stock',
  out_of_stock: 'out_of_stock',
  outofstock: 'out_of_stock',
  'out of stock': 'out_of_stock',
  preorder: 'preorder',
  'pre-order': 'preorder',
  backorder: 'backorder',
  limited_availability: 'limited_availability',
};

function emptyProduct(offerId: string): ProductData {
  return {
    offerId,
    title: null,
    description: null,
    link: null,
    imageLink: null,
    additionalImageLinks: [],
    price: null,
    salePrice: null,
    availability: null,
    condition: null,
    brand: null,
    gtins: [],
    mpn: null,
    identifierExists: null,
    googleProductCategory: null,
    productTypes: [],
    itemGroupId: null,
    color: null,
    material: null,
    pattern: null,
    size: null,
    gender: null,
    ageGroup: null,
    productDetails: [],
  };
}

const stripHtml = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|div|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export interface ParsedFeed {
  format: ProductFeedPreviewDto['format'];
  rows: number;
  products: ProductData[];
  columns: { name: string; mappedTo: string | null }[];
  ignoredColumns: string[];
  rowErrors: { row: number; message: string }[];
  limitations: string[];
}

export function parseProductFeed(
  content: string,
  options: { country: string; websiteUrl: string | null },
): ParsedFeed {
  const delimiter = detectDelimiter(content);
  const table = parseDelimited(content, delimiter);
  const headers = (table[0] ?? []).map((h) => h.trim());
  const keys = headers.map(key);
  const shopify = keys.includes('handle') && keys.includes('variant_price');
  const mapping = shopify ? SHOPIFY_COLUMNS : (GOOGLE_COLUMNS as Record<string, string>);
  const columns = headers.map((name, i) => ({ name, mappedTo: mapping[keys[i]!] ?? null }));
  const rowErrors: ParsedFeed['rowErrors'] = [];
  const limitations: string[] = [];
  const defaultCurrency = COUNTRY_CURRENCY[options.country] ?? null;
  let assumedCurrency = 0;
  const body = table.slice(1);
  if (body.length > PRODUCT_FEED_MAX_ROWS) {
    limitations.push(`Only the first ${PRODUCT_FEED_MAX_ROWS.toLocaleString('en-US')} rows were read.`);
    body.length = PRODUCT_FEED_MAX_ROWS;
  }
  if (!headers.length || !columns.some((c) => c.mappedTo === 'offerId'))
    return {
      format: shopify ? 'SHOPIFY_CSV' : delimiter === '\t' ? 'GOOGLE_TSV' : 'GOOGLE_CSV',
      rows: body.length,
      products: [],
      columns,
      ignoredColumns: headers.filter((_, i) => !columns[i]!.mappedTo),
      rowErrors: [{ row: 1, message: shopify ? 'The file has no "Variant SKU" column.' : 'The file has no "id" column. The first row must hold Google attribute names such as id, title, link and price.' }], // prettier-ignore
      limitations,
    };

  const price = (raw: string) => {
    const parsed = parsePrice(raw, defaultCurrency);
    if (parsed.assumedCurrency) assumedCurrency += 1;
    return parsed.money;
  };
  const products: ProductData[] = [];
  const seen = new Map<string, number>();
  const shopifyParent = new Map<string, Record<string, string>>();
  body.forEach((cells, index) => {
    const rowNumber = index + 2;
    const v: Record<string, string> = {};
    cells.forEach((cell, i) => {
      const field = columns[i]?.mappedTo;
      if (!field) return;
      const value = cell.trim();
      if (field === 'product_detail' && v[field]) v[field] += `\u0000${value}`;
      else if (field === 'additionalImageLinks' && v[field]) v[field] += `,${value}`;
      else v[field] = value;
    });
    if (shopify) {
      const handle = v.handle ?? '';
      if (v.title) shopifyParent.set(handle, v);
      const parent = shopifyParent.get(handle);
      // Image-only rows (no SKU and no price) add images to their product.
      if (!v.offerId && !v.feed_price) return;
      for (const f of [
        'title',
        'description',
        'brand',
        'productTypes',
        'googleProductCategory',
        'imageLink',
        'status',
      ])
        if (!v[f] && parent?.[f]) v[f] = parent[f]!;
      if (!v.offerId)
        v.offerId = handle && v.o1v ? `${handle}-${v.o1v}`.toLowerCase().replace(/\s+/g, '-') : handle;
      v.itemGroupId = handle;
      if (v.status && v.status.toLowerCase() !== 'active') return;
    }
    const offerId = (v.offerId ?? '').trim();
    if (!offerId) {
      rowErrors.push({ row: rowNumber, message: 'No product id: the row was skipped.' });
      return;
    }
    if (seen.has(offerId)) {
      rowErrors.push({ row: rowNumber, message: `Duplicate id "${offerId.slice(0, 60)}" (first on row ${seen.get(offerId)}): the row was skipped.` }); // prettier-ignore
      return;
    }
    seen.set(offerId, rowNumber);
    const p = emptyProduct(offerId.slice(0, 50));
    p.title = v.title || null;
    p.description = v.description ? (shopify ? stripHtml(v.description) : v.description) || null : null;
    p.link = v.link || null;
    p.imageLink = v.variantImage || v.imageLink || null;
    p.additionalImageLinks = v.additionalImageLinks ? list(v.additionalImageLinks).slice(0, 10) : [];
    p.price = v.feed_price ? price(v.feed_price) : null;
    if (shopify) {
      const compare = v.compare_at ? price(v.compare_at) : null;
      // Shopify's "compare at" price is the regular price when the variant price is a sale.
      if (compare && p.price && compare.amount > p.price.amount) {
        p.salePrice = p.price;
        p.price = compare;
      }
      const qty = v.inventory === undefined || v.inventory === '' ? null : Number(v.inventory);
      p.availability = qty === null || Number.isNaN(qty) ? null : qty > 0 ? 'in_stock' : 'out_of_stock';
      p.itemGroupId = v.handle || null;
      if (options.websiteUrl && v.handle)
        p.link = `${options.websiteUrl.replace(/\/$/, '')}/products/${encodeURIComponent(v.handle)}`;
      for (const [n, val] of [
        [v.o1n, v.o1v],
        [v.o2n, v.o2v],
        [v.o3n, v.o3v],
      ] as const) {
        const name = (n ?? '').toLowerCase();
        if (!val || val === 'Default Title') continue;
        if (name.includes('size')) p.size = val;
        else if (name.includes('colo')) p.color = val;
        else if (name.includes('material') || name.includes('metal')) p.material = val;
      }
    } else {
      p.salePrice = v.feed_sale_price ? price(v.feed_sale_price) : null;
      p.availability = v.availability ? (AVAILABILITY_ALIASES[v.availability.toLowerCase()] ?? v.availability.toLowerCase()) : null; // prettier-ignore
      p.condition = v.condition ? v.condition.toLowerCase() : null;
      p.mpn = v.mpn || null;
      p.identifierExists = v.identifierExists ? !/^(no|false|n|0)$/i.test(v.identifierExists) : null;
      p.itemGroupId = v.itemGroupId || null;
      p.color = v.color || null;
      p.material = v.material || null;
      p.pattern = v.pattern || null;
      p.size = v.size || null;
      p.gender = v.gender ? v.gender.toLowerCase() : null;
      p.ageGroup = v.ageGroup ? v.ageGroup.toLowerCase() : null;
      p.productDetails = (v.product_detail ?? '')
        .split('\u0000')
        .filter(Boolean)
        .map((d) => {
          const parts = d.split(':').map((x) => x.trim());
          return parts.length >= 3
            ? { section: parts[0] || null, name: parts[1]!, value: parts.slice(2).join(':') }
            : { section: null, name: parts[0] ?? '', value: parts.slice(1).join(':') };
        })
        .filter((d) => d.name && d.value)
        .slice(0, 50);
    }
    p.brand = v.brand || null;
    p.gtins = v.gtins
      ? list(v.gtins)
          .map((g) => g.replace(/[\s-]/g, ''))
          .slice(0, 10)
      : [];
    p.googleProductCategory = v.googleProductCategory || null;
    p.productTypes = v.productTypes
      ? v.productTypes
          .split(/\s*,\s*/)
          .filter(Boolean)
          .slice(0, 5)
      : [];
    products.push(p);
  });
  if (assumedCurrency)
    limitations.push(
      `${assumedCurrency} price${assumedCurrency === 1 ? ' has' : 's have'} no currency in the file; ${defaultCurrency} (the currency of ${options.country}) was assumed.`,
    );
  if (shopify)
    limitations.push(
      options.websiteUrl
        ? 'Shopify export: product links were built as <website>/products/<handle>; availability comes from the inventory quantity.'
        : 'Shopify export without a website in Surfaced: products have no landing page link.',
      'Shopify export: condition, gender and age group are not in the file.',
    );
  return {
    format: shopify ? 'SHOPIFY_CSV' : delimiter === '\t' ? 'GOOGLE_TSV' : 'GOOGLE_CSV',
    rows: body.length,
    products,
    columns,
    ignoredColumns: headers.filter((_, i) => !columns[i]!.mappedTo),
    rowErrors: rowErrors.slice(0, 200),
    limitations,
  };
}
