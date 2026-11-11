import { parseLength } from './units.js';

/** A 2D affine transform: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface Matrix {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Composes two matrices so that applying the result = applying m1 after m2 (m1 · m2). */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
    return {
        a: m1.a * m2.a + m1.c * m2.b,
        b: m1.b * m2.a + m1.d * m2.b,
        c: m1.a * m2.c + m1.c * m2.d,
        d: m1.b * m2.c + m1.d * m2.d,
        e: m1.a * m2.e + m1.c * m2.f + m1.e,
        f: m1.b * m2.e + m1.d * m2.f + m1.f,
    };
}

/** True when every coefficient matches the identity within 1e-12. */
export const isIdentity = (m: Matrix): boolean =>
    Object.entries(IDENTITY).every(([k, v]) => Math.abs(m[k as keyof Matrix] - v) < 1e-12);

/** Serializes a matrix as an SVG `matrix(a b c d e f)` transform. */
export const formatMatrix = (m: Matrix): string => `matrix(${m.a} ${m.b} ${m.c} ${m.d} ${m.e} ${m.f})`;

export function applyPoint(m: Matrix, x: number, y: number): [number, number] {
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

/** Uniform-ish scale factor of a matrix (area-preserving), used to scale radii. */
export function scaleFactor(m: Matrix): number {
    return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
}

const translation = (tx: number, ty: number): Matrix => ({ ...IDENTITY, e: tx, f: ty });
const scaling = (sx: number, sy: number): Matrix => ({ ...IDENTITY, a: sx, d: sy });
const rad = (deg: number): number => (deg * Math.PI) / 180;
function rotation(deg: number): Matrix {
    const cos = Math.cos(rad(deg));
    const sin = Math.sin(rad(deg));
    return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}
/** CSS `skew(ax, ay)`; `skewX(a)` is `skew(a, 0)` and `skewY(a)` is `skew(0, a)`. */
const skewing = (ax: number, ay: number): Matrix => ({ ...IDENTITY, b: Math.tan(rad(ay)), c: Math.tan(rad(ax)) });

/** `m` applied around the point (ox, oy) instead of the origin: translate(o) · m · translate(−o). */
export const aroundOrigin = (m: Matrix, ox: number, oy: number): Matrix =>
    multiply(translation(ox, oy), multiply(m, translation(-ox, -oy)));

/**
 * Parses an SVG transform list (translate/scale/rotate/skewX/skewY/matrix) into one matrix.
 * Returns null when there is nothing parseable, so callers keep untransformed coordinates.
 */
export function parseTransform(transform: string | undefined): Matrix | null {
    if (!transform) return null;
    let m = IDENTITY;
    let matched = false;
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
    let fn: RegExpExecArray | null;
    while ((fn = re.exec(transform)) !== null) {
        const name = fn[1]!.toLowerCase();
        const args = fn[2]!
            .split(/[\s,]+/)
            .map(Number)
            .filter((n) => !Number.isNaN(n));
        let next: Matrix | null = null;
        switch (name) {
            case 'matrix':
                if (args.length >= 6)
                    next = { a: args[0]!, b: args[1]!, c: args[2]!, d: args[3]!, e: args[4]!, f: args[5]! };
                break;
            case 'translate':
                next = translation(args[0] ?? 0, args[1] ?? 0);
                break;
            case 'scale':
                next = scaling(args[0] ?? 1, args[1] ?? args[0] ?? 1);
                break;
            case 'rotate':
                next = rotation(args[0] ?? 0);
                if (args.length >= 3) next = aroundOrigin(next, args[1]!, args[2]!);
                break;
            case 'skewx':
                next = skewing(args[0] ?? 0, 0);
                break;
            case 'skewy':
                next = skewing(0, args[0] ?? 0);
                break;
        }
        if (next) {
            m = multiply(m, next);
            matched = true;
        }
    }
    return matched ? m : null;
}

/** Degrees per CSS angle unit (a unitless angle is read as degrees, as SVG does). */
const ANGLE_DEG: Record<string, number> = { '': 1, deg: 1, rad: 180 / Math.PI, grad: 0.9, turn: 360 };
const CSS_NUMBER_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z]*|%)$/i;

/** A CSS angle in degrees (NaN when unparseable). */
function cssAngle(v: string): number {
    const m = CSS_NUMBER_RE.exec(v);
    const factor = m ? ANGLE_DEG[m[2]!.toLowerCase()] : undefined;
    return factor === undefined ? NaN : parseFloat(m![1]!) * factor;
}

/** A CSS `<number>` (NaN when unparseable or followed by a unit). */
function cssNumber(v: string): number {
    const m = CSS_NUMBER_RE.exec(v);
    return m && m[2] === '' ? parseFloat(m[1]!) : NaN;
}

/** A CSS `<number>` or `<percentage>` (`scale(50%)` = `scale(0.5)`; NaN when unparseable). */
const cssFactor = (v: string): number => (v.endsWith('%') ? cssNumber(v.slice(0, -1)) / 100 : cssNumber(v));

/** Matrix of one CSS transform function (lengths in user units, angles in degrees), or null. */
function cssFunctionMatrix(name: string, args: readonly string[]): Matrix | null {
    const lengths = args.map((a) => parseLength(a));
    const numbers = args.map(cssNumber);
    const factors = args.map(cssFactor);
    const angles = args.map(cssAngle);
    const n = args.length;
    let m: Matrix | null = null;
    switch (name) {
        case 'matrix':
            if (n === 6) {
                const [a, b, c, d, e, f] = numbers as [number, number, number, number, number, number];
                m = { a, b, c, d, e, f };
            }
            break;
        case 'translate':
            if (n === 1 || n === 2) m = translation(lengths[0]!, lengths[1] ?? 0);
            break;
        case 'translatex':
            if (n === 1) m = translation(lengths[0]!, 0);
            break;
        case 'translatey':
            if (n === 1) m = translation(0, lengths[0]!);
            break;
        case 'scale':
            if (n === 1 || n === 2) m = scaling(factors[0]!, factors[1] ?? factors[0]!);
            break;
        case 'scalex':
            if (n === 1) m = scaling(factors[0]!, 1);
            break;
        case 'scaley':
            if (n === 1) m = scaling(1, factors[0]!);
            break;
        case 'rotate':
            if (n === 1) m = rotation(angles[0]!);
            break;
        case 'skew':
            if (n === 1 || n === 2) m = skewing(angles[0]!, angles[1] ?? 0);
            break;
        case 'skewx':
            if (n === 1) m = skewing(angles[0]!, 0);
            break;
        case 'skewy':
            if (n === 1) m = skewing(0, angles[0]!);
            break;
    }
    return m && Object.values(m).every(Number.isFinite) ? m : null;
}

/**
 * Parses a CSS `transform` property value into one matrix (`none` is the identity). Returns null
 * when some part is not a 2D transform with absolute units: percentages of the reference box,
 * font-relative lengths, 3D functions, `calc()` / `var()`, or a syntax error.
 */
export function parseCssTransform(value: string): Matrix | null {
    const s = value.trim();
    if (s.toLowerCase() === 'none') return IDENTITY;
    const re = /\s*([a-z][a-z0-9]*)\(([^()]*)\)\s*/iy;
    let m = IDENTITY;
    let matched = false;
    let fn: RegExpExecArray | null;
    while (re.lastIndex < s.length && (fn = re.exec(s)) !== null) {
        const args = fn[2]!.trim().split(/\s*,\s*|\s+/);
        const next = cssFunctionMatrix(fn[1]!.toLowerCase(), args);
        if (!next) return null;
        m = multiply(m, next);
        matched = true;
    }
    return matched && re.lastIndex === s.length ? m : null;
}

/** `transform-origin` keywords: share of the reference box. */
const ORIGIN_KEYWORDS = new Map([
    ['left', 0],
    ['top', 0],
    ['center', 0.5],
    ['right', 1],
    ['bottom', 1],
]);
const VERTICAL = new Set(['top', 'bottom']);
const HORIZONTAL = new Set(['left', 'right']);

/**
 * One `transform-origin` component in px of a box side `ref`: NaN for a keyword of the other axis
 * and, without a box, for a component that depends on it (`center`, a non-zero percentage…).
 */
function originComponent(v: string, ref: number | undefined, wrongAxis: ReadonlySet<string>): number {
    if (wrongAxis.has(v)) return NaN;
    const share = ORIGIN_KEYWORDS.get(v);
    const at = (side: number): number => (share === undefined ? parseLength(v, side) : share * side);
    if (ref !== undefined) return at(ref);
    const value = at(0);
    return value === at(1) ? value : NaN;
}

/**
 * Resolves a CSS `transform-origin` (`<x> [<y> [<z>]]`, CSS Transforms 1 §6): keywords (two of
 * them in either order) and percentages against the reference `box`, lengths through
 * `parseLength`. Without a box, only what does not depend on it resolves (lengths, `left` / `top`,
 * `0%`). `z` only moves 3D transforms: checked, then ignored. Null when invalid or not resolvable
 * (`ex`, `vw`, `calc()`, a box-relative component without a box…).
 */
export function parseTransformOrigin(
    value: string,
    box?: { width: number; height: number },
): { x: number; y: number } | null {
    const parts = value.trim().toLowerCase().split(/\s+/);
    if (parts.length > 3 || (parts[2] !== undefined && !Number.isFinite(parseLength(parts[2])))) return null;
    let x = parts[0]!;
    let y = parts[1] ?? 'center';
    // A lone vertical keyword sets y; two keywords may come in either order.
    if (parts.length === 1 && VERTICAL.has(x)) [x, y] = ['center', x];
    else if (ORIGIN_KEYWORDS.has(x) && ORIGIN_KEYWORDS.has(y) && (VERTICAL.has(x) || HORIZONTAL.has(y)))
        [x, y] = [y, x];
    const ox = originComponent(x, box?.width, VERTICAL);
    const oy = originComponent(y, box?.height, HORIZONTAL);
    return Number.isFinite(ox) && Number.isFinite(oy) ? { x: ox, y: oy } : null;
}

export interface Decomposed {
    translateX: number;
    translateY: number;
    /** degrees */
    rotation: number;
    scaleX: number;
    scaleY: number;
    /** true when the matrix has shear an Android <group> cannot represent exactly. */
    hasSkew: boolean;
}

/**
 * Decomposes a matrix into translate/rotate/scale (matching an Android `<group>`, which applies
 * scale → rotate → translate). Skew is detected and reported (not representable by a group).
 */
export function decompose(m: Matrix): Decomposed {
    const { a, b, c, d, e, f } = m;
    const scaleX = Math.hypot(a, b);
    const rotation = Math.atan2(b, a);
    const det = a * d - b * c;
    const scaleY = scaleX === 0 ? 0 : det / scaleX;
    // shear term: dot of the (normalized) X axis with the Y axis
    const shear = scaleX === 0 ? 0 : (a * c + b * d) / (scaleX * scaleX);
    return {
        translateX: e,
        translateY: f,
        rotation: (rotation * 180) / Math.PI,
        scaleX,
        scaleY,
        hasSkew: Math.abs(shear) > 1e-4,
    };
}
