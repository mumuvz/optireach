// Chart colors. Categorical slots are the documented reference palette in its fixed order,
// validated on the dashboard's chart surface (#ffffff) with the dataviz six-checks validator:
// adjacent CVD ΔE 9.1, normal-vision ΔE 19.6; the first three slots pass all-pairs.
// Slots 3–5 (aqua, yellow, magenta) are below 3:1 on white, so every chart ships a legend,
// selective direct labels and a table view. Colors are bound to entities, never to rank.
export const SERIES = [
  '#2a78d6',
  '#eb6834',
  '#1baf7a',
  '#eda100',
  '#e87ba4',
  '#008300',
  '#6250d6',
  '#e34948',
] as const;

/** De-emphasis ("context") marks in emphasis charts and the folded "Other" segment. */
export const DEEMPHASIS = '#898781';

/** Sequential blue (meters): light track and fill from the same ramp. */
export const SEQ_TRACK = '#cde2fb';
export const SEQ_FILL = '#2a78d6';

export const CHROME = {
  surface: '#ffffff',
  grid: '#e1e0d9',
  baseline: '#c3c2b7',
  tick: '#52514e',
  ink: '#0b0b0b',
} as const;

/** Stable slot per entity: brand first, then competitors in project order. */
export function entityColor(index: number): string {
  return SERIES[index % SERIES.length]!;
}
