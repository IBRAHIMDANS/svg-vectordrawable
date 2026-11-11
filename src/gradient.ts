import type { BBox, Viewport, XastElement } from './ast.js';
import { toAndroidColor } from './color.js';
import type { ColorRefs } from './colorRef.js';
import { ANIMATIONS } from './elements.js';
import { presentation } from './style.js';
import { applyPoint, IDENTITY, multiply, parseTransform, scaleFactor, type Matrix } from './transform.js';
import type { Warning } from './types.js';
import { parseLength } from './units.js';

/** A gradient color stop, with its offset normalized to [0, 1]. */
interface GradientStop {
    offset: number;
    color: string;
}

type TileMode = 'clamp' | 'repeated' | 'mirror';
const SPREAD: Record<string, TileMode> = { pad: 'clamp', repeat: 'repeated', reflect: 'mirror' };

/** A gradient as declared in the SVG, before resolving against a viewport or path bounding box. */
export interface RawGradient {
    type: 'linear' | 'radial';
    /** true for gradientUnits="objectBoundingBox" (the SVG default). */
    objectBox: boolean;
    attrs: Record<string, string>;
    matrix: Matrix | null;
    stops: GradientStop[];
    tileMode?: TileMode;
    /**
     * Reports, on the first call only, what the gradient loses in a VectorDrawable (an unparseable
     * stop color, `linearRGB` interpolation the stops cannot match, SMIL animations). Called on each use, so a gradient
     * that is never painted reports nothing, in both `optimize` modes.
     */
    report?: () => void;
}

/** A gradient with Android coordinates computed, ready to render. */
export interface ResolvedGradient {
    type: 'linear' | 'radial';
    coords: Record<string, number>;
    stops: GradientStop[];
    tileMode?: TileMode;
}

const round = (v: number, p: number): number => {
    const f = 10 ** p;
    return Math.round(v * f) / f;
};

/** Relative tolerance used to tell a similarity (uniform scale + rotation) from a general affine map. */
const SIMILARITY_TOLERANCE = 1e-3;

/** true when `a` and `b` are equal up to a tiny fraction of the reference length `ref`. */
const nearlyEqual = (a: number, b: number, ref: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, ref);

/** true when the linear part of `m` cannot be inverted (zero or non-finite determinant). */
function isSingular(m: Matrix): boolean {
    const det = m.a * m.d - m.b * m.c;
    const norm = Math.max(m.a * m.a + m.b * m.b, m.c * m.c + m.d * m.d);
    return !Number.isFinite(det) || Math.abs(det) <= 1e-12 * norm;
}

/**
 * true when the linear part of `m` maps circles to circles: both columns have the same length and
 * are orthogonal (reflections allowed), within a relative tolerance.
 */
function isSimilarity(m: Matrix): boolean {
    const col1 = m.a * m.a + m.b * m.b;
    const col2 = m.c * m.c + m.d * m.d;
    const scale = Math.max(col1, col2);
    if (scale === 0) return true;
    const dot = m.a * m.c + m.b * m.d;
    return Math.abs(col1 - col2) <= SIMILARITY_TOLERANCE * scale && Math.abs(dot) <= SIMILARITY_TOLERANCE * scale;
}

/**
 * Exact Android end point for an SVG linear gradient under the affine map `m`.
 *
 * In gradient space the parameter is t(P) = ((P − P0)·v)/(v·v) with v = P1 − P0. In user space,
 * t(X) = ((M⁻¹X − P0)·v)/(v·v) = (X − S)·w with S = M·P0 and w = M⁻ᵀ·v/(v·v) (L = linear part of M).
 * Android's linear gradient has t(X) = ((X − S)·(E − S))/|E − S|², so E = S + w/(w·w). Isolines
 * stay perpendicular to w, which differs from M·v when M shears or scales non-uniformly; for a
 * similarity, E = M·P1. Returns null when v is zero or M is singular (callers map P1 as-is).
 */
function linearEnd(m: Matrix, vx: number, vy: number, sx: number, sy: number): [number, number] | null {
    const vv = vx * vx + vy * vy;
    if (vv === 0 || isSingular(m)) return null;
    const det = m.a * m.d - m.b * m.c;
    // M⁻ᵀ = (1/det)·[[d, −b], [−c, a]] on the linear part
    const wx = (m.d * vx - m.b * vy) / det / vv;
    const wy = (-m.c * vx + m.a * vy) / det / vv;
    const ww = wx * wx + wy * wy;
    return [sx + wx / ww, sy + wy / ww];
}

/**
 * Parses a coordinate: a length in user units (absolute units resolved, `1in` → 96, in
 * objectBoundingBox units too, per SVG) or a percentage of `ref`. `ex` / `ch` or malformed
 * values keep their leading number, as before; nothing parseable yields `fallback`.
 */
function coord(value: string | undefined, fallback: number, ref: number): number {
    if (value === undefined) return fallback;
    const length = parseLength(value, ref);
    if (!Number.isNaN(length)) return length;
    const v = value.trim();
    const n = v.endsWith('%') ? (parseFloat(v) / 100) * ref : parseFloat(v);
    return Number.isNaN(n) ? fallback : n;
}

/** Parses a stop offset (number or percentage); missing or invalid values yield 0. */
function parseOffset(value: string | undefined): number {
    const v = value?.trim() ?? '0';
    const n = v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
    return Number.isNaN(n) ? 0 : n;
}

/**
 * Applies SVG stop rules: each offset is clamped to [0, 1] and raised to at least the previous
 * offset. A single stop paints a solid color in SVG, so it is duplicated at offsets 0 and 1 to
 * keep a valid two-item Android `<gradient>` with the exact same rendering.
 */
function normalizeStops(stops: GradientStop[]): GradientStop[] {
    let prev = 0;
    const out = stops.map((s) => {
        prev = Math.max(prev, Math.min(1, Math.max(0, s.offset)));
        return { offset: prev, color: s.color };
    });
    if (out.length === 1) {
        const color = out[0]!.color;
        return [
            { offset: 0, color },
            { offset: 1, color },
        ];
    }
    return out;
}

/** true for a coordinate {@link coord} reads (a length, a percentage, or a leading number). */
const isCoordinate = (v: string): boolean => !Number.isNaN(parseLength(v, 1)) || !Number.isNaN(parseFloat(v));

/** Valid values of the attributes a gradient inherits through `href`. */
const VALID: Record<string, (v: string) => boolean> = {
    ...Object.fromEntries(['x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'fx', 'fy', 'fr'].map((k) => [k, isCoordinate])),
    gradientUnits: (v) => v === 'userSpaceOnUse' || v === 'objectBoundingBox',
    spreadMethod: (v) => Object.hasOwn(SPREAD, v),
    // `none` is left out as well, like svgo does, so both `optimize` modes inherit the same transform.
    gradientTransform: (v) => parseTransform(v) !== null,
};

/**
 * The attributes of `el` that count as specified: an empty or invalid value of an inherited
 * gradient attribute is left out, so the template's value (or the initial one) applies — wpt
 * `pservers/reftests/{linear,radial}-gradient-transform-empty-attr.svg`. Without a template this is
 * SVG 2's rule for an invalid value (types §4.2: the initial value), so nothing changes there.
 */
function specifiedAttrs(el: XastElement): Record<string, string> {
    return Object.fromEntries(Object.entries(el.attributes ?? {}).filter(([k, v]) => VALID[k]?.(v) ?? true));
}

/** `color-interpolation` keywords that set the property; anything else defers to the parent. */
const INTERPOLATION_VALUES = new Set(['auto', 'srgb', 'linearrgb', 'initial']);

/**
 * true when `color-interpolation` computes to `linearRGB` on the gradient element: the property is
 * inherited (SVG 2 painting, "Inherited: yes"), so it comes from `el` or, failing that, from its nearest
 * document ancestor (`ancestors`, nearest first) that sets it. `inherit`, `unset` and invalid values
 * defer to the parent; `auto` / `initial` mean sRGB. It does not flow through `href`: a template
 * supplies attributes and stops, while properties cascade along the document tree only.
 */
function isLinearRgb(el: XastElement, ancestors: readonly XastElement[]): boolean {
    for (const node of [el, ...ancestors]) {
        const value = presentation(node, 'color-interpolation')?.trim().toLowerCase();
        if (value !== undefined && INTERPOLATION_VALUES.has(value)) return value === 'linearrgb';
    }
    return false;
}

/** Encoded sRGB component (0–1) → linear light. */
const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Linear light (0–1) → encoded sRGB component. */
const toEncoded = (l: number): number => (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);

/**
 * Largest residual a `linearRGB` gradient may keep, in 8-bit channel units: 1 % of 255. Below it the
 * intermediate stops make the sRGB interpolation of VectorDrawable match linear-light interpolation.
 */
const LINEAR_RGB_TOLERANCE = 2.55;
/**
 * Candidate offsets per stop segment, uniformly spaced; the fit is checked on
 * {@link LINEAR_RGB_SAMPLES} points per candidate interval. The grid must be fine at the dark end,
 * where the sRGB curve is steepest: with 64 candidates the first interval of black → white alone
 * deviates by 4.9 units, with 256 by 0.1. Measured: black → white (the worst channel swing) then
 * needs 6 intermediate stops, white → blue 6, blue → red 10, red → yellow 6.
 */
const LINEAR_RGB_GRID = 256;
/** Error samples per grid interval (the interval ends included). */
const LINEAR_RGB_SAMPLES = 4;
/**
 * Cap on the items of an expanded gradient (9 alternating black / white stops already need 57);
 * beyond it the declared stops are kept and the approximation is reported.
 */
const LINEAR_RGB_MAX_STOPS = 64;

/** `#AARRGGBB` → [a, r, g, b] in 0–255, or null for anything else (a color resource reference). */
function argb(color: string): number[] | null {
    if (!/^#[0-9a-f]{8}$/i.test(color)) return null;
    return [1, 3, 5, 7].map((i) => parseInt(color.slice(i, i + 2), 16));
}

const toHex = (channels: number[]): string =>
    '#' + channels.map((c) => Math.round(c).toString(16).padStart(2, '0').toUpperCase()).join('');

/**
 * Intermediate stops strictly between (o0, c0) and (o1, c1), [a, r, g, b] 0–255, sampled from the
 * exact linear-light blend: color channels are converted to linear light, interpolated and
 * converted back; alpha is linear either way. Greedy fit on a {@link LINEAR_RGB_GRID} grid: from
 * each emitted stop, the next one is the farthest candidate (binary search) such that the sRGB
 * chord between the two stops as emitted (offset rounded to 4 decimals, color rounded to 8 bits)
 * stays below {@link LINEAR_RGB_TOLERANCE} at every sample in between. A segment already within
 * tolerance gets none.
 */
function linearRgbSegment(o0: number, c0: number[], o1: number, c1: number[]): GradientStop[] {
    if (o1 - o0 < 1e-4) return []; // a hard stop: nothing is interpolated
    const l0 = c0.map((c, k) => (k === 0 ? c / 255 : toLinear(c / 255)));
    const l1 = c1.map((c, k) => (k === 0 ? c / 255 : toLinear(c / 255)));
    /** The exact blend at offset x. */
    const exact = (x: number): number[] =>
        l0.map((l, k) => {
            const v = l + ((l1[k]! - l) * (x - o0)) / (o1 - o0);
            return 255 * (k === 0 ? v : toEncoded(v));
        });
    const n = LINEAR_RGB_GRID * LINEAR_RGB_SAMPLES;
    const samples = Array.from({ length: n + 1 }, (_, k) => {
        const x = o0 + ((o1 - o0) * k) / n;
        return { x, color: exact(x) };
    });
    /** The stop emitted at grid index j. */
    const at = (j: number): GradientStop & { channels: number[] } => {
        if (j === LINEAR_RGB_GRID) return { offset: o1, color: '', channels: c1 };
        const offset = round(o0 + ((o1 - o0) * j) / LINEAR_RGB_GRID, 4);
        const channels = exact(offset).map(Math.round);
        return { offset, color: toHex(channels), channels };
    };
    /** true when the chord from stop `a` (grid index ia) to grid index ib stays within tolerance. */
    const fits = (ia: number, a: { offset: number; channels: number[] }, ib: number): boolean => {
        const b = at(ib);
        if (b.offset <= a.offset) return true; // rounded onto `a`: never emitted
        for (let k = ia * LINEAR_RGB_SAMPLES; k <= ib * LINEAR_RGB_SAMPLES; k++) {
            const { x, color } = samples[k]!;
            const u = Math.min(1, Math.max(0, (x - a.offset) / (b.offset - a.offset)));
            for (let ch = 0; ch < 4; ch++) {
                const chord = a.channels[ch]! + (b.channels[ch]! - a.channels[ch]!) * u;
                if (Math.abs(chord - color[ch]!) >= LINEAR_RGB_TOLERANCE) return false;
            }
        }
        return true;
    };
    const out: GradientStop[] = [];
    let from = 0;
    let fromStop = { offset: o0, channels: c0 };
    while (from < LINEAR_RGB_GRID && !fits(from, fromStop, LINEAR_RGB_GRID)) {
        // the farthest grid index that fits: from + 1 always qualifies (one interval is tiny)
        let lo = from + 1;
        let hi = LINEAR_RGB_GRID;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (fits(from, fromStop, mid)) lo = mid;
            else hi = mid;
        }
        const stop = at(lo);
        if (stop.offset > fromStop.offset && stop.offset < o1) {
            out.push({ offset: stop.offset, color: stop.color });
            fromStop = stop;
        }
        from = lo;
    }
    return out;
}

/**
 * Stops of a `linearRGB` gradient for the sRGB interpolation of VectorDrawable: every segment gets
 * the intermediate stops of {@link linearRgbSegment}, so the rendering stays within 1 % of the
 * linear-light one. Returns null when a stop is not a literal color (a `@color/` reference) or the
 * result exceeds {@link LINEAR_RGB_MAX_STOPS} items.
 */
export function linearRgbStops(stops: readonly GradientStop[]): GradientStop[] | null {
    const parsed = stops.map((s) => argb(s.color));
    if (parsed.some((c) => c === null)) return null;
    const out: GradientStop[] = [stops[0]!];
    for (let i = 1; i < stops.length; i++) {
        out.push(...linearRgbSegment(stops[i - 1]!.offset, parsed[i - 1]!, stops[i]!.offset, parsed[i]!), stops[i]!);
        if (out.length > LINEAR_RGB_MAX_STOPS) return null;
    }
    return out;
}

/** Calls `fn` on the first call only. */
function once(fn: () => void): () => void {
    let done = false;
    return () => {
        if (done) return;
        done = true;
        fn();
    };
}

/**
 * Builds the gradient lookup, resolving `href`/`xlink:href` inheritance (shared stops/attributes).
 * Coordinates are kept raw; placement happens in {@link resolveGradient} so objectBoundingBox
 * gradients can use the filled path's bounding box. Gradients without stops are left out, and
 * so are those with a non-invertible gradientTransform (an invalid paint server: the paint's
 * fallback color applies). What a gradient loses goes to `warn` when it is first used (see
 * {@link RawGradient.report}).
 */
export function collectGradients(
    gradientEls: XastElement[],
    currentColor: string,
    warn: (w: Warning) => void,
    /** Android references for stop colors (`currentColor` / `colorMap` options); literals without it. */
    colors?: ColorRefs,
    /**
     * The document root the gradients belong to, so inherited properties (`color-interpolation`)
     * are read from their ancestors too; without it only the gradient element itself is read.
     */
    root?: XastElement,
): Map<string, RawGradient> {
    const parents = new Map<XastElement, XastElement>();
    const link = (node: XastElement): void => {
        for (const child of node.children ?? []) {
            parents.set(child, node);
            link(child);
        }
    };
    if (root) link(root);
    /** Document ancestors of `el`, nearest first. */
    const ancestors = (el: XastElement): XastElement[] => {
        const out: XastElement[] = [];
        for (let p = parents.get(el); p; p = parents.get(p)) out.push(p);
        return out;
    };
    const byId = new Map<string, XastElement>();
    for (const el of gradientEls) {
        const id = el.attributes?.id;
        if (id) byId.set(id, el);
    }
    /** `el` then its templates, nearest first (at most 10 `href` hops, cycles cut). */
    const chainOf = (el: XastElement): XastElement[] => {
        const chain = [el];
        for (let i = 0; i < 10; i++) {
            const href = chain[i]!.attributes?.href ?? chain[i]!.attributes?.['xlink:href'];
            const next = href?.startsWith('#') ? byId.get(href.slice(1)) : undefined;
            if (!next || chain.includes(next)) break;
            chain.push(next);
        }
        return chain;
    };

    const out = new Map<string, RawGradient>();
    for (const el of gradientEls) {
        const id = el.attributes?.id;
        if (!id) continue;
        const chain = chainOf(el);
        const a = Object.assign({}, ...chain.map(specifiedAttrs).reverse()) as Record<string, string>;
        // The nearest element of the chain with stops supplies them all (SVG 2 §14.1.1).
        const stopEls =
            chain.map((g) => (g.children ?? []).filter((c) => c.name === 'stop')).find((s) => s.length) ?? [];
        const notes: Warning[] = [];
        const stopColor = (s: XastElement, opacity: number | undefined): string => {
            const value = presentation(s, 'stop-color') ?? '#000';
            const color = colors ? colors.stop(value, opacity, id) : toAndroidColor(value, opacity, currentColor);
            if (color) return color;
            // An invalid value means the initial black (SVG 2 types §4.2); a valid one the parser
            // does not know is lost.
            notes.push({
                code: 'unsupported-paint',
                message: `Gradient "${id}" has stop-color="${value.trim()}", not a color the converter can parse; using black.`,
                node: 'stop',
            });
            return colors ? colors.stop('#000000', opacity, id)! : toAndroidColor('#000000', opacity, currentColor)!;
        };
        const declared = normalizeStops(
            stopEls.map((s) => {
                const opacity = presentation(s, 'stop-opacity');
                const color = stopColor(s, opacity !== undefined ? parseFloat(opacity) : undefined);
                return { offset: parseOffset(presentation(s, 'offset')), color };
            }),
        );
        if (declared.length === 0) continue;
        const linear = isLinearRgb(el, ancestors(el));
        // linearRGB: intermediate stops make the sRGB rendering match; reported when they cannot.
        const expanded = linear ? linearRgbStops(declared) : declared;
        const stops = expanded ?? declared;
        if (!expanded)
            notes.push({
                code: 'gradient-approximated',
                message: `Gradient "${id}" has color-interpolation="linearRGB": VectorDrawable interpolates in sRGB, so the mid-tones differ.`,
                node: el.name!,
            });
        for (const owner of [...chain, ...stopEls])
            for (const child of owner.children ?? [])
                if (child.type === 'element' && ANIMATIONS.has(child.name ?? ''))
                    notes.push({
                        code: 'unsupported-element',
                        message: `<${child.name}> in gradient "${id}" cannot be represented in a VectorDrawable; the static value is used.`,
                        node: child.name!,
                    });
        const matrix = parseTransform(a.gradientTransform);
        // A non-invertible gradientTransform makes the paint server invalid (CSS Transforms 1 §8):
        // like browsers (wpt gradient-transform-01/02), the paint then uses its fallback color.
        if (matrix && isSingular(matrix)) continue;

        const tileMode = a.spreadMethod ? SPREAD[a.spreadMethod] : undefined;
        out.set(id, {
            type: el.name === 'radialGradient' ? 'radial' : 'linear',
            objectBox: (a.gradientUnits ?? 'objectBoundingBox') !== 'userSpaceOnUse',
            attrs: a,
            matrix,
            stops,
            ...(tileMode ? { tileMode } : {}),
            ...(notes.length ? { report: once(() => notes.forEach(warn)) } : {}),
        });
    }
    return out;
}

/** Gradient space: the matrix mapping it to user space and the references of its percentages. */
interface GradientFrame {
    base: Matrix;
    refW: number;
    refH: number;
    refD: number;
}

/** The gradient space of `g`; `bb` is the box objectBoundingBox units map onto. */
function gradientFrame(g: RawGradient, bb: BBox, viewport: Viewport): GradientFrame {
    if (g.objectBox)
        return {
            // unit square → bounding box, then the gradient's own transform inside the unit square
            base: multiply({ a: bb.width, b: 0, c: 0, d: bb.height, e: bb.x, f: bb.y }, g.matrix ?? IDENTITY),
            refW: 1,
            refH: 1,
            refD: 1, // normalized diagonal of the unit square: sqrt((1² + 1²) / 2), per SVG
        };
    return {
        base: g.matrix ?? IDENTITY,
        refW: viewport.width,
        refH: viewport.height,
        refD: Math.hypot(viewport.width, viewport.height) / Math.SQRT2,
    };
}

/** Radial center, radius and focal flag in gradient space. */
function radialCircle(
    a: Record<string, string>,
    { refW, refH, refD }: GradientFrame,
): { cx: number; cy: number; r: number; focal: boolean } {
    const cx = coord(a.cx, 0.5 * refW, refW);
    const cy = coord(a.cy, 0.5 * refH, refH);
    const fx = coord(a.fx, cx, refW);
    const fy = coord(a.fy, cy, refH);
    return {
        cx,
        cy,
        r: coord(a.r, 0.5 * refD, refD),
        focal: !nearlyEqual(fx, cx, refW) || !nearlyEqual(fy, cy, refH),
    };
}

/** Reports a radial focal point (fx/fy ≠ cx/cy): Android radials are always centered. */
export function warnFocal(warn: (w: Warning) => void): void {
    warn({
        code: 'gradient-approximated',
        message: 'Radial gradient focal point (fx/fy) is not supported; centered on cx/cy.',
        node: 'radialGradient',
    });
}

/**
 * Computes Android gradient coordinates. For `userSpaceOnUse`, coordinates are viewport-relative.
 * For `objectBoundingBox` (the SVG default), the unit square is mapped through the path's bounding
 * box — falling back to the viewport (with a warning) when the box is unavailable.
 */
export function resolveGradient(
    g: RawGradient,
    bbox: BBox | null,
    viewport: Viewport,
    precision: number,
    warn: (w: Warning) => void,
): ResolvedGradient {
    g.report?.();
    if (g.objectBox && !bbox)
        warn({
            code: 'gradient-bbox-unavailable',
            message: 'objectBoundingBox gradient could not use the path bounding box; approximated to the viewport.',
        });
    const frame = gradientFrame(g, bbox ?? { x: 0, y: 0, width: viewport.width, height: viewport.height }, viewport);
    const { base, refW, refH } = frame;

    const a = g.attrs;
    const scale = scaleFactor(base);
    if (g.type === 'radial') {
        const { cx, cy, r, focal } = radialCircle(a, frame);
        const [centerX, centerY] = applyPoint(base, cx, cy);
        if (!isSimilarity(base))
            warn({
                code: 'gradient-approximated',
                message:
                    'Elliptical radial gradient (non-uniform scale or skew) approximated by a circle of equivalent area.',
                node: 'radialGradient',
            });
        if (focal) warnFocal(warn);
        return {
            type: 'radial',
            coords: {
                centerX: round(centerX, precision),
                centerY: round(centerY, precision),
                gradientRadius: round(r * scale, precision),
            },
            stops: g.stops,
            ...(g.tileMode ? { tileMode: g.tileMode } : {}),
        };
    }
    const x1 = coord(a.x1, 0, refW);
    const y1 = coord(a.y1, 0, refH);
    const x2 = coord(a.x2, refW, refW);
    const y2 = coord(a.y2, 0, refH);
    const [sx, sy] = applyPoint(base, x1, y1);
    const exact = linearEnd(base, x2 - x1, y2 - y1, sx, sy);
    // a zero-length vector (x1,y1 = x2,y2) is SVG-valid: it paints the last stop, nothing to approximate
    if (!exact && (x1 !== x2 || y1 !== y2))
        warn({
            code: 'gradient-approximated',
            message: 'Linear gradient with a degenerate gradientTransform; endpoints mapped as-is.',
            node: 'linearGradient',
        });
    const [ex, ey] = exact ?? applyPoint(base, x2, y2);
    return {
        type: 'linear',
        coords: {
            startX: round(sx, precision),
            startY: round(sy, precision),
            endX: round(ex, precision),
            endY: round(ey, precision),
        },
        stops: g.stops,
        ...(g.tileMode ? { tileMode: g.tileMode } : {}),
    };
}

/** Inverse of an invertible affine matrix. */
function invert(m: Matrix): Matrix {
    const det = m.a * m.d - m.b * m.c;
    const a = m.d / det;
    const b = -m.b / det;
    const c = -m.c / det;
    const d = m.a / det;
    return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

/** An elliptical radial gradient made exact: a circular gradient inside a transformed `<group>`. */
export interface EllipticalRadial {
    /** `<group>` rotation in degrees, rounded as emitted. */
    rotation: number;
    /** `<group>` scaleY (|scaleY| < 1, negative for a reflection), rounded as emitted; scaleX is 1. */
    scaleY: number;
    /** Inverse of the emitted group matrix: maps the path's coordinates into the group's local space. */
    toLocal: Matrix;
    /** The circular gradient, in the group's local space. */
    gradient: ResolvedGradient;
    /** true when fx/fy differ from cx/cy (still approximated: Android radials have no focal point). */
    focal: boolean;
}

/**
 * Renders an elliptical radial gradient exactly. Let M = outer · base map gradient space to the
 * space of the emitted path (`outer` being a transform baked into the geometry), with linear part
 * L. Its SVD reads L = R(φ)·diag(s₁, s₂)·R(θ) with s₁ ≥ |s₂| (s₂ < 0 for a reflection), i.e.
 *   L = G·(s₁·R(θ)),  G = R(φ)·diag(1, s₂/s₁).
 * G is one Android `<group>` (scale, then rotate; no translation). In its local space the path is
 * drawn as G⁻¹·X, and the gradient space reaches it through G⁻¹·M = s₁·R(θ) + translation: a
 * similarity, so the SVG circle stays a circle there — center G⁻¹·M·c, radius s₁·r. A second
 * group for R(θ) is unnecessary since a rotation maps the circle onto itself. Normalizing by s₁
 * (not √|det|) keeps |G| ≤ 1: rounding errors of the local geometry shrink when drawn.
 *
 * G is built from its rounded attributes, so the local geometry inverts exactly what Android applies.
 * Returns null (callers keep {@link resolveGradient}'s approximation) for a linear gradient, a
 * circular one (similarity M), a singular M, a missing objectBoundingBox box, or a group scale
 * that rounds to 0 or ±1.
 */
export function resolveEllipticalRadial(
    g: RawGradient,
    bbox: BBox | null,
    viewport: Viewport,
    precision: number,
    outer: Matrix = IDENTITY,
): EllipticalRadial | null {
    g.report?.(); // the caller paints `g` either way: exactly here, or through resolveGradient
    if (g.type !== 'radial' || (g.objectBox && !bbox)) return null;
    const frame = gradientFrame(g, bbox ?? { x: 0, y: 0, width: 0, height: 0 }, viewport);
    const m = multiply(outer, frame.base);
    if (isSingular(m) || isSimilarity(m)) return null;

    // Closed-form 2×2 SVD of [[a, c], [b, d]] = R(φ)·diag(s₁, s₂)·R(θ).
    const e = (m.a + m.d) / 2;
    const f = (m.a - m.d) / 2;
    const gg = (m.b + m.c) / 2;
    const h = (m.b - m.c) / 2;
    const q = Math.hypot(e, h);
    const r = Math.hypot(f, gg);
    const s1 = q + r;
    const s2 = q - r;
    const phi = (Math.atan2(h, e) + Math.atan2(gg, f)) / 2;

    const rotation = round((phi * 180) / Math.PI, precision);
    const scaleY = round(s2 / s1, precision);
    if (scaleY === 0 || Math.abs(scaleY) === 1) return null;
    const t = (rotation * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const toLocal = invert({ a: cos, b: sin, c: -sin * scaleY, d: cos * scaleY, e: 0, f: 0 });

    const local = multiply(toLocal, m); // gradient space → local space (a similarity, up to rounding)
    const circle = radialCircle(g.attrs, frame);
    const [centerX, centerY] = applyPoint(local, circle.cx, circle.cy);
    return {
        rotation,
        scaleY,
        toLocal,
        gradient: {
            type: 'radial',
            coords: {
                centerX: round(centerX, precision),
                centerY: round(centerY, precision),
                gradientRadius: round(circle.r * scaleFactor(local), precision),
            },
            stops: g.stops,
            ...(g.tileMode ? { tileMode: g.tileMode } : {}),
        },
        focal: circle.focal,
    };
}

/** Renders a resolved gradient as an `<aapt:attr name="android:fillColor">` (or `strokeColor`) block. */
export function renderGradient(
    g: ResolvedGradient,
    pad: string,
    step: string,
    attr: 'fillColor' | 'strokeColor' = 'fillColor',
): string {
    const inner = pad + step + step;
    const coordLines = Object.entries(g.coords)
        .map(([k, v]) => `${inner + step}android:${k}="${v}"`)
        .join('\n');
    const tile = g.tileMode ? `\n${inner + step}android:tileMode="${g.tileMode}"` : '';
    const items = g.stops
        .map((s) => `${inner + step}<item android:offset="${s.offset}" android:color="${s.color}" />`)
        .join('\n');
    return (
        `${pad + step}<aapt:attr name="android:${attr}">\n` +
        `${inner}<gradient\n${coordLines}\n${inner + step}android:type="${g.type}"${tile}>\n` +
        `${items}\n` +
        `${inner}</gradient>\n` +
        `${pad + step}</aapt:attr>`
    );
}
