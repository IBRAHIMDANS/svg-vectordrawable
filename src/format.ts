/** Escapes characters that would break an XML attribute value. */
export const escapeXml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Formats a number rounded to `precision` decimal places (no trailing zeros). */
export const formatNumber = (v: number, precision: number): string =>
    String(Math.round(v * 10 ** precision) / 10 ** precision);
