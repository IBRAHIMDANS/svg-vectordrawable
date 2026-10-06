/** User units (px) per absolute unit, at the CSS reference of 96 px per inch. */
const UNIT_PX: Record<string, number> = {
    '': 1,
    px: 1,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    pt: 4 / 3,
    pc: 16,
};

const LENGTH_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*|%)$/i;

/**
 * Parses an SVG length into user units. `%` resolves against `ref` (NaN when no reference is
 * given). Font-relative units (`em`, `ex`) and anything unparseable yield NaN, so callers fall back.
 */
export function parseLength(v: string | undefined, ref?: number): number {
    const m = v === undefined ? null : LENGTH_RE.exec(v.trim());
    if (!m) return NaN;
    const value = parseFloat(m[1]!);
    const unit = m[2]!.toLowerCase();
    if (unit === '%') return ref === undefined ? NaN : (value / 100) * ref;
    const factor = UNIT_PX[unit];
    return factor === undefined ? NaN : value * factor;
}

/** Parses an opacity (number or percentage), clamped to [0, 1]; unparseable values give `fallback`. */
export function parseOpacity(v: string | undefined, fallback = 1): number {
    if (v === undefined) return fallback;
    const s = v.trim();
    const parsed = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s);
    return Number.isNaN(parsed) ? fallback : Math.min(Math.max(parsed, 0), 1);
}
