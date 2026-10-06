import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import {
    collectGradients,
    renderGradient,
    resolveEllipticalRadial,
    resolveGradient,
    type BBox,
    type RawGradient,
    type XastElement,
} from '../src/gradient.js';
import { applyPoint, IDENTITY, multiply, parseTransform, type Matrix } from '../src/transform.js';
import type { Warning } from '../src/types.js';

const noWarn = (_w: Warning): void => {};

/** Builds a `<stop>` element from raw attributes. */
const stop = (attributes: Record<string, string>): XastElement => ({ type: 'element', name: 'stop', attributes });

/** Builds a linear gradient element with the given stops. */
const linear = (id: string, stops: XastElement[], attributes: Record<string, string> = {}): XastElement => ({
    type: 'element',
    name: 'linearGradient',
    attributes: { id, ...attributes },
    children: stops,
});

/** Collects a single gradient and returns its stops. */
function stopsOf(el: XastElement): { offset: number; color: string }[] | undefined {
    return collectGradients([el], '#000', noWarn).get(el.attributes!.id!)?.stops;
}

describe('collectGradients — stop presentation via style', () => {
    it('reads stop-color from the inline style', () => {
        const stops = stopsOf(linear('g', [stop({ offset: '0', style: 'stop-color:#f00' })]));
        expect(stops?.[0]?.color).toBe('#FFFF0000');
    });

    it('combines stop-color and stop-opacity from the inline style', () => {
        const stops = stopsOf(linear('g', [stop({ offset: '0', style: 'stop-color:#f00;stop-opacity:0.5' })]));
        expect(stops?.[0]?.color).toBe('#80FF0000');
    });

    it('prefers the inline style over the attribute', () => {
        const stops = stopsOf(linear('g', [stop({ offset: '0', 'stop-color': '#00f', style: 'stop-color:#0f0' })]));
        expect(stops?.[0]?.color).toBe('#FF00FF00');
    });

    it('combines a stop-opacity style with a stop-color attribute', () => {
        const stops = stopsOf(linear('g', [stop({ offset: '0', 'stop-color': '#00f', style: 'stop-opacity:0' })]));
        expect(stops?.[0]?.color).toBe('#000000FF');
    });

    it('reads offset from the inline style', () => {
        const stops = stopsOf(
            linear('g', [stop({ offset: '0', 'stop-color': '#000' }), stop({ style: 'offset:50%;stop-color:#fff' })]),
        );
        expect(stops?.map((s) => s.offset)).toEqual([0, 0.5]);
    });
});

describe('collectGradients — offset normalisation', () => {
    it('clamps to [0, 1] and enforces monotonic offsets', () => {
        const stops = stopsOf(
            linear('g', [
                stop({ offset: '0.8', 'stop-color': '#000' }),
                stop({ offset: '0.2', 'stop-color': '#fff' }),
                stop({ offset: '1.5', 'stop-color': '#f00' }),
            ]),
        );
        expect(stops?.map((s) => s.offset)).toEqual([0.8, 0.8, 1]);
    });

    it('clamps negative and percentage offsets', () => {
        const stops = stopsOf(
            linear('g', [
                stop({ offset: '-0.5', 'stop-color': '#000' }),
                stop({ offset: '40%', 'stop-color': '#fff' }),
                stop({ offset: '250%', 'stop-color': '#f00' }),
            ]),
        );
        expect(stops?.map((s) => s.offset)).toEqual([0, 0.4, 1]);
    });

    it('treats a missing or invalid offset as 0, then raises it to the previous one', () => {
        const stops = stopsOf(
            linear('g', [
                stop({ offset: '0.3', 'stop-color': '#000' }),
                stop({ offset: 'abc', 'stop-color': '#fff' }),
                stop({ 'stop-color': '#f00' }),
            ]),
        );
        expect(stops?.map((s) => s.offset)).toEqual([0.3, 0.3, 0.3]);
    });
});

describe('collectGradients — stop count', () => {
    it('duplicates a single stop at offsets 0 and 1 (solid color)', () => {
        const stops = stopsOf(linear('g', [stop({ offset: '0.4', style: 'stop-color:#f00' })]));
        expect(stops).toEqual([
            { offset: 0, color: '#FFFF0000' },
            { offset: 1, color: '#FFFF0000' },
        ]);
    });

    it('renders a single-stop gradient as two items', () => {
        const raw = collectGradients([linear('g', [stop({ offset: '0', 'stop-color': '#f00' })])], '#000', noWarn).get(
            'g',
        )!;
        const xml = renderGradient(resolveGradient(raw, null, { width: 24, height: 24 }, 2, noWarn), '', '  ');
        const items = xml.match(/<item [^>]*\/>/g) ?? [];
        expect(items).toEqual([
            '<item android:offset="0" android:color="#FFFF0000" />',
            '<item android:offset="1" android:color="#FFFF0000" />',
        ]);
    });

    it('targets android:fillColor by default and android:strokeColor on request', () => {
        const g = resolveGradient(raw('linear', {}, undefined, false), null, { width: 24, height: 24 }, 2, noWarn);
        const fill = renderGradient(g, '', '  ');
        expect(fill).toMatch(/^ {2}<aapt:attr name="android:fillColor">\n/);
        expect(renderGradient(g, '', '  ', 'fillColor')).toBe(fill);
        const stroke = renderGradient(g, '', '  ', 'strokeColor');
        expect(stroke).toMatch(/^ {2}<aapt:attr name="android:strokeColor">\n/);
        expect(stroke.replace('strokeColor', 'fillColor')).toBe(fill);
    });

    it('skips a gradient without stops', () => {
        expect(collectGradients([linear('g', [])], '#000', noWarn).has('g')).toBe(false);
    });
});

const VIEWPORT = { width: 24, height: 24 };
const STOPS = [
    { offset: 0, color: '#FF000000' },
    { offset: 1, color: '#FFFFFFFF' },
];

/** Builds a raw gradient directly, bypassing element collection. */
function raw(
    type: 'linear' | 'radial',
    attrs: Record<string, string>,
    transform?: string,
    objectBox = false,
): RawGradient {
    return { type, objectBox, attrs, matrix: parseTransform(transform), stops: STOPS };
}

/** Resolves a gradient at high precision and records the emitted warnings. */
function resolve(g: RawGradient, bbox: BBox | null = null): { coords: Record<string, number>; warnings: Warning[] } {
    const warnings: Warning[] = [];
    const { coords } = resolveGradient(g, bbox, VIEWPORT, 10, (w) => warnings.push(w));
    return { coords, warnings };
}

/** Inverts an affine matrix (test helper; assumes it is invertible). */
function invert(m: Matrix): Matrix {
    const det = m.a * m.d - m.b * m.c;
    const a = m.d / det;
    const b = -m.b / det;
    const c = -m.c / det;
    const d = m.a / det;
    return { a, b, c, d, e: -(a * m.e + c * m.f), f: -(b * m.e + d * m.f) };
}

describe('resolveGradient — linear under an affine gradientTransform', () => {
    const P0: [number, number] = [2, 3];
    const P1: [number, number] = [10, 7];
    const attrs = { x1: '2', y1: '3', x2: '10', y2: '7' };
    const samples: [number, number][] = [
        [0, 0],
        [5, 5],
        [12, -4],
        [20, 18],
        [-7, 9],
    ];

    /** SVG gradient parameter at user-space point X: project M⁻¹X onto P0→P1. */
    const svgParam = (m: Matrix, [x, y]: [number, number]): number => {
        const [gx, gy] = applyPoint(invert(m), x, y);
        const vx = P1[0] - P0[0];
        const vy = P1[1] - P0[1];
        return ((gx - P0[0]) * vx + (gy - P0[1]) * vy) / (vx * vx + vy * vy);
    };

    /** Android linear gradient parameter at X: project X onto start→end. */
    const androidParam = (c: Record<string, number>, [x, y]: [number, number]): number => {
        const dx = c.endX! - c.startX!;
        const dy = c.endY! - c.startY!;
        return ((x - c.startX!) * dx + (y - c.startY!) * dy) / (dx * dx + dy * dy);
    };

    for (const transform of ['skewX(40)', 'scale(3 1)', 'matrix(1.5 0.4 -0.8 0.6 3 -2)', 'rotate(25) skewY(-20)']) {
        it(`matches the SVG parameter field under ${transform}`, () => {
            const { coords, warnings } = resolve(raw('linear', attrs, transform));
            const m = parseTransform(transform)!;
            for (const p of samples) expect(androidParam(coords, p)).toBeCloseTo(svgParam(m, p), 6);
            expect(warnings).toEqual([]);
        });
    }

    it('starts at M·P0 and keeps the transformed P1 isoline at t = 1', () => {
        const m = parseTransform('skewX(40)')!;
        const { coords } = resolve(raw('linear', attrs, 'skewX(40)'));
        const [sx, sy] = applyPoint(m, ...P0);
        expect(coords.startX).toBeCloseTo(sx, 8);
        expect(coords.startY).toBeCloseTo(sy, 8);
        expect(androidParam(coords, applyPoint(m, ...P1))).toBeCloseTo(1, 8);
    });

    it('handles objectBoundingBox on a non-square box (non-uniform mapping)', () => {
        const bbox = { x: 1, y: 2, width: 20, height: 5 };
        const g = raw('linear', { x1: '0', y1: '0', x2: '1', y2: '1' }, undefined, true);
        const { coords, warnings } = resolve(g, bbox);
        const m = multiply({ a: 20, b: 0, c: 0, d: 5, e: 1, f: 2 }, IDENTITY);
        const unitParam = (p: [number, number]): number => {
            const [gx, gy] = applyPoint(invert(m), ...p);
            return (gx + gy) / 2;
        };
        for (const p of samples) expect(androidParam(coords, p)).toBeCloseTo(unitParam(p), 6);
        expect(warnings).toEqual([]);
    });

    it('maps both endpoints unchanged under a conformal transform', () => {
        const m = parseTransform('translate(4 1) rotate(30) scale(2)')!;
        const { coords } = resolve(raw('linear', attrs, 'translate(4 1) rotate(30) scale(2)'));
        const [ex, ey] = applyPoint(m, ...P1);
        expect(coords.endX).toBeCloseTo(ex, 8);
        expect(coords.endY).toBeCloseTo(ey, 8);
    });

    it('falls back to the mapped endpoints with a warning when the transform is singular', () => {
        const { coords, warnings } = resolve(raw('linear', attrs, 'scale(0 1)'));
        expect(coords).toEqual({ startX: 0, startY: 3, endX: 0, endY: 7 });
        expect(warnings.map((w) => w.code)).toEqual(['gradient-approximated']);
    });
});

describe('resolveGradient — radial approximations', () => {
    const codes = (g: RawGradient, bbox: BBox | null = null): string[] => resolve(g, bbox).warnings.map((w) => w.code);
    const circle = { cx: '0', cy: '0', r: '1' };

    it('warns for a non-uniform scale (elliptical radial)', () => {
        expect(codes(raw('radial', circle, 'translate(12 12) scale(10 4)'))).toEqual(['gradient-approximated']);
    });

    it('warns for a skewed transform', () => {
        expect(codes(raw('radial', circle, 'skewX(30)'))).toEqual(['gradient-approximated']);
    });

    it('warns for objectBoundingBox on a non-square box', () => {
        expect(codes(raw('radial', {}, undefined, true), { x: 0, y: 0, width: 20, height: 10 })).toEqual([
            'gradient-approximated',
        ]);
    });

    it('keeps the sqrt(|det|) radius approximation', () => {
        const { coords } = resolve(raw('radial', circle, 'translate(12 12) scale(10 4)'));
        expect(coords.gradientRadius).toBeCloseTo(Math.sqrt(40), 8);
    });

    it('warns when the focal point differs from the center', () => {
        expect(codes(raw('radial', { cx: '12', cy: '12', r: '6', fx: '10', fy: '12' }))).toEqual([
            'gradient-approximated',
        ]);
    });

    it('does not warn when the focal point equals the center', () => {
        expect(codes(raw('radial', { cx: '12', cy: '12', r: '6', fx: '12', fy: '12' }))).toEqual([]);
    });

    it('does not warn for uniform scale, rotation and translation', () => {
        expect(codes(raw('radial', circle, 'translate(12 12) rotate(33) scale(-12 12)'))).toEqual([]);
        expect(codes(raw('radial', circle, 'translate(12 12) scale(12)'))).toEqual([]);
        expect(codes(raw('radial', {}, undefined, true), { x: 3, y: 4, width: 10, height: 10 })).toEqual([]);
    });
});

describe('radial radius in objectBoundingBox units', () => {
    it('resolves the default r="50%" against the unit square normalized diagonal (1), not sqrt(2)/2', () => {
        const { xml } = convert(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
                '<radialGradient id="r"><stop stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>' +
                '<path d="M0 0h20v20H0z" fill="url(#r)"/></svg>',
            { optimize: false },
        );
        // Browsers render r = 0.5 × bbox size = 10 for a 20×20 box.
        expect(xml).toContain('android:gradientRadius="10"');
    });
});

describe('resolveEllipticalRadial — exact elliptical radial in a transformed group', () => {
    const circle = { cx: '0', cy: '0', r: '1' };
    const samples: [number, number][] = [
        [12, 12],
        [3, 5],
        [20, 9],
        [14, 21],
        [-4, 30],
    ];

    /** Android group matrix: rotate(rotation) · scale(1, scaleY), as a `<group>` applies it. */
    const groupMatrix = (rotation: number, scaleY: number): Matrix => {
        const t = (rotation * Math.PI) / 180;
        return { a: Math.cos(t), b: Math.sin(t), c: -Math.sin(t) * scaleY, d: Math.cos(t) * scaleY, e: 0, f: 0 };
    };

    /**
     * Checks that the circular local gradient, seen through the group, has the SVG parameter field:
     * t(X) = |M⁻¹X − c| / r in gradient space equals |toLocal·X − center| / radius in local space.
     */
    function expectExact(g: RawGradient, m: Matrix, bbox: BBox | null = null, outer?: Matrix): void {
        const exact = resolveEllipticalRadial(g, bbox, VIEWPORT, 10, outer);
        expect(exact).not.toBeNull();
        const { rotation, scaleY, toLocal, gradient } = exact!;
        // toLocal is the inverse of the group matrix Android applies
        const back = multiply(groupMatrix(rotation, scaleY), toLocal);
        for (const [k, v] of Object.entries(IDENTITY)) expect(back[k as keyof Matrix]).toBeCloseTo(v, 8);
        expect(Math.abs(scaleY)).toBeLessThanOrEqual(1);
        const { centerX, centerY, gradientRadius } = gradient.coords;
        const cx = parseFloat(g.attrs.cx ?? '0.5');
        const cy = parseFloat(g.attrs.cy ?? '0.5');
        const r = parseFloat(g.attrs.r ?? '0.5');
        for (const [x, y] of samples) {
            const [gx, gy] = applyPoint(invert(m), x, y);
            const [lx, ly] = applyPoint(toLocal, x, y);
            const svgT = Math.hypot(gx - cx, gy - cy) / r;
            const androidT = Math.hypot(lx - centerX!, ly - centerY!) / gradientRadius!;
            expect(androidT).toBeCloseTo(svgT, 6);
        }
    }

    for (const transform of [
        'translate(12 12) scale(10 4)',
        'translate(12 12) skewX(30) scale(8)',
        'translate(12 12) rotate(30) scale(10 4)',
        'matrix(1.5 0.4 -0.8 0.6 3 -2)',
        'translate(12 12) scale(-10 4)',
    ]) {
        it(`matches the SVG parameter field under ${transform}`, () => {
            expectExact(raw('radial', circle, transform), parseTransform(transform)!);
        });
    }

    it('maps objectBoundingBox through the bounding box (24×6 rect)', () => {
        const bbox = { x: 0, y: 9, width: 24, height: 6 };
        expectExact(raw('radial', {}, undefined, true), { a: 24, b: 0, c: 0, d: 6, e: 0, f: 9 }, bbox);
    });

    it('composes an outer (baked) transform', () => {
        const outer = parseTransform('skewX(20)')!;
        const g = raw('radial', { cx: '12', cy: '12', r: '8' });
        expectExact(g, outer, null, outer);
    });

    it('keeps the group scaleX at 1 and the shrunk axis in scaleY', () => {
        const exact = resolveEllipticalRadial(raw('radial', circle, 'translate(12 12) scale(10 4)'), null, VIEWPORT, 3);
        expect(exact).toMatchObject({ rotation: 0, scaleY: 0.4 });
        expect(exact!.gradient.coords).toEqual({ centerX: 12, centerY: 30, gradientRadius: 10 });
    });

    it('flags a focal point', () => {
        const g = raw('radial', { cx: '0', cy: '0', r: '1', fx: '0.5' }, 'translate(12 12) scale(10 4)');
        expect(resolveEllipticalRadial(g, null, VIEWPORT, 3)?.focal).toBe(true);
        expect(resolveEllipticalRadial(raw('radial', circle, 'scale(10 4)'), null, VIEWPORT, 3)?.focal).toBe(false);
    });

    it('returns null for a similarity, a linear gradient, a singular matrix or a missing bbox', () => {
        expect(
            resolveEllipticalRadial(raw('radial', circle, 'translate(12 12) rotate(33) scale(12)'), null, VIEWPORT, 3),
        ).toBeNull();
        expect(resolveEllipticalRadial(raw('linear', {}, 'scale(10 4)'), null, VIEWPORT, 3)).toBeNull();
        expect(resolveEllipticalRadial(raw('radial', circle, 'scale(10 0)'), null, VIEWPORT, 3)).toBeNull();
        expect(resolveEllipticalRadial(raw('radial', {}, undefined, true), null, VIEWPORT, 3)).toBeNull();
    });
});
