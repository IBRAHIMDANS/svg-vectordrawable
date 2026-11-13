/** The initial CSS `font-size` (`medium`), in px: what `em` / `rem` resolve against here. */
const FONT_SIZE_PX = 16;

/**
 * User units (px) per unit: absolute units at the CSS reference of 96 px per inch, `em` / `rem` at
 * `FONT_SIZE_PX`.
 */
const UNIT_PX: Record<string, number> = {
    '': 1,
    px: 1,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    pt: 4 / 3,
    pc: 16,
    em: FONT_SIZE_PX,
    rem: FONT_SIZE_PX,
};

/**
 * Largest finite single-precision float. SVG numbers are floats in browsers and in Android's
 * `PathParser`: beyond it Firefox draws nothing (Chrome clamps), and a VectorDrawable cannot hold it.
 */
export const FLOAT_MAX = 3.4028234663852886e38;

/** Whether `v` is a finite number a float can hold (NaN is not). */
export const inFloatRange = (v: number): boolean => Math.abs(v) <= FLOAT_MAX;

const LENGTH_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*|%)$/i;

/**
 * A CSS length the converter cannot resolve but a browser can: a unit that depends on fonts, the
 * viewport or a container, `Q`, a percentage, or a function (`calc()`, `var()`…). Anything else
 * (`abc`, `10abc`) is not a length at all.
 */
export const VALID_UNRESOLVED_LENGTH =
    /^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:%|r?(?:ex|ch|ic|cap|lh)|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max)|q)|[a-z-]+\(.*\))$/i;

/**
 * Parses an SVG length into user units. `%` resolves against `ref` (NaN when no reference is
 * given). `em` and `rem` count 16 px, the initial font-size a browser uses for an SVG document:
 * a `font-size` set on the element or an ancestor is not read, so `em` under a changed font-size is
 * approximate. `ex`, `ch` (they depend on font metrics) and anything unparseable yield NaN, so
 * callers fall back.
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
