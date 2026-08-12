/**
 * WCAG relative-luminance contrast, used to verify the palette rather than
 * eyeball it.
 *
 * Kept in source rather than in the test file so the numbers can be recomputed
 * whenever the token mapping changes, and so a future palette decision has the
 * same tool available.
 */

/** WCAG AA minimum for text below 18px, which is every label in this UI. */
export const AA_TEXT = 4.5;

/** WCAG AA minimum for graphics and UI components: dots, borders, icons. */
export const AA_GRAPHIC = 3;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const raw = hex.replace("#", "");
  if (raw.length !== 6) {
    throw new Error(`Expected a 6-digit hex colour, got "${hex}"`);
  }
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(raw.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
