import { toAndroidColor } from './color.js';
import { presentation } from './style.js';
import { applyPoint, IDENTITY, multiply, parseTransform, scaleFactor, type Matrix } from './transform.js';
import type { Warning } from './types.js';

export interface XastElement {
    type: string;
    name?: string;
    attributes?: Record<string, string>;
    children?: XastElement[];
}

export interface Viewport {
    width: number;
    height: number;
}

export interface BBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

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

/** Parses a coordinate (number or percentage). Percentages are taken relative to `ref`. */
function coord(value: string | undefined, fallback: number, ref: number): number {
    if (value === undefined) return fallback;
    const v = value.trim();
    if (v.endsWith('%')) return (parseFloat(v) / 100) * ref;
    const n = parseFloat(v);
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

/**
 * Builds the gradient lookup, resolving `href`/`xlink:href` inheritance (shared stops/attributes).
 * Coordinates are kept raw; placement happens in {@link resolveGradient} so objectBoundingBox
 * gradients can use the filled path's bounding box.
 */
export function collectGradients(
    gradientEls: XastElement[],
    currentColor: string,
    // Kept for call-site symmetry with resolveGradient; collection itself never warns.
    _warn: (w: Warning) => void,
): Map<string, RawGradient> {
    const byId = new Map<string, XastElement>();
    for (const el of gradientEls) {
        const id = el.attributes?.id;
        if (id) byId.set(id, el);
    }
    const attrsOf = (el: XastElement, seen = 0): Record<string, string> => {
        const href = el.attributes?.href ?? el.attributes?.['xlink:href'];
        const parent = seen < 10 && href?.startsWith('#') ? byId.get(href.slice(1)) : undefined;
        return { ...(parent ? attrsOf(parent, seen + 1) : {}), ...el.attributes };
    };
    const stopsOf = (el: XastElement, seen = 0): XastElement[] => {
        const own = (el.children ?? []).filter((c) => c.name === 'stop');
        if (own.length) return own;
        const href = el.attributes?.href ?? el.attributes?.['xlink:href'];
        const parent = seen < 10 && href?.startsWith('#') ? byId.get(href.slice(1)) : undefined;
        return parent ? stopsOf(parent, seen + 1) : [];
    };

    const out = new Map<string, RawGradient>();
    for (const el of gradientEls) {
        const id = el.attributes?.id;
        if (!id) continue;
        const a = attrsOf(el);
        const stops = normalizeStops(
            stopsOf(el)
                .map((s) => {
                    const opacity = presentation(s, 'stop-opacity');
                    const color = toAndroidColor(
                        presentation(s, 'stop-color') ?? '#000',
                        opacity !== undefined ? parseFloat(opacity) : undefined,
                        currentColor,
                    );
                    return color ? { offset: parseOffset(presentation(s, 'offset')), color } : null;
                })
                .filter((s): s is NonNullable<typeof s> => s !== null),
        );
        if (stops.length === 0) continue;

        const tileMode = a.spreadMethod ? SPREAD[a.spreadMethod] : undefined;
        out.set(id, {
            type: el.name === 'radialGradient' ? 'radial' : 'linear',
            objectBox: (a.gradientUnits ?? 'objectBoundingBox') !== 'userSpaceOnUse',
            attrs: a,
            matrix: parseTransform(a.gradientTransform),
            stops,
            ...(tileMode ? { tileMode } : {}),
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
