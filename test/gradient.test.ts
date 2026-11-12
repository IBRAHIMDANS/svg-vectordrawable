import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import {
    collectGradients,
    linearRgbStops,
    renderGradient,
    resolveEllipticalRadial,
    resolveGradient,
    type RawGradient,
} from '../src/gradient.js';
import type { BBox, XastElement } from '../src/ast.js';
import { colorRefs } from '../src/colorRef.js';
import { applyPoint, IDENTITY, multiply, parseTransform, type Matrix } from '../src/transform.js';
import type { Warning } from '../src/types.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';
import { vdToSvg } from './visual/vdToSvg.js';

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

    it('keeps a gradient without stops, which paints none', () => {
        expect(collectGradients([linear('g', [])], '#000', noWarn).get('g')?.stops).toEqual([]);
    });
});

describe('collectGradients — Android color references', () => {
    const els = [
        linear('a', [
            stop({ offset: '0', 'stop-color': 'red' }),
            stop({ offset: '0.5', 'stop-color': 'currentColor' }),
            stop({ offset: '1', 'stop-color': '#00f', 'stop-opacity': '0.5' }),
        ]),
        linear('b', [stop({ offset: '0', 'stop-color': '#00f', 'stop-opacity': '0.5' })]),
    ];

    it('resolves opaque stops to references and keeps translucent ones literal, warning once per gradient', () => {
        const warnings: Warning[] = [];
        const colors = colorRefs('?attr/tint', { '#f00': '@color/brand', blue: '@color/sea' }, (w) => warnings.push(w));
        const gradients = collectGradients(els, '?attr/tint', noWarn, colors);
        expect(gradients.get('a')!.stops.map((s) => s.color)).toEqual(['@color/brand', '?attr/tint', '#800000FF']);
        expect(gradients.get('b')!.stops.map((s) => s.color)).toEqual(['#800000FF', '#800000FF']);
        expect(warnings.map((w) => [w.code, w.node])).toEqual([
            ['unsupported-color-reference', 'stop'],
            ['unsupported-color-reference', 'stop'],
        ]);
        expect(warnings.map((w) => w.message.match(/"(\w)"/)![1])).toEqual(['a', 'b']);
    });

    it('matches the literal behaviour without references', () => {
        const literal = collectGradients(els, '#123456', noWarn);
        const resolved = collectGradients(els, '#123456', noWarn, colorRefs('#123456', undefined));
        expect(resolved).toEqual(literal);
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

describe('gradient coordinates with absolute units', () => {
    it('resolves an absolute unit in objectBoundingBox units to user units (1in → 96, not 1)', () => {
        const bbox = { x: 10, y: 0, width: 2, height: 4 };
        const { coords } = resolve(raw('linear', { x1: '0', y1: '0', x2: '1in', y2: '0' }, undefined, true), bbox);
        expect(coords).toEqual({ startX: 10, startY: 0, endX: 10 + 96 * 2, endY: 0 });
    });

    it('resolves absolute units in userSpaceOnUse and radial coordinates', () => {
        expect(resolve(raw('linear', { x1: '1pc', y1: '3pt', x2: '25.4mm', y2: '2.54cm' })).coords).toEqual({
            startX: 16,
            startY: 4,
            endX: 96,
            endY: 96,
        });
        expect(resolve(raw('radial', { cx: '6pt', cy: '12px', r: '0.125in' })).coords).toEqual({
            centerX: 8,
            centerY: 12,
            gradientRadius: 12,
        });
    });

    it('keeps percentages, plain numbers and font-relative units as before', () => {
        const g = raw('linear', { x1: '25%', y1: '0.5', x2: '2ex', y2: '' }, undefined, true);
        const { coords } = resolve(g, { x: 0, y: 0, width: 8, height: 8 });
        expect(coords).toEqual({ startX: 2, startY: 4, endX: 16, endY: 0 });
    });
});

describe('collectGradients — non-invertible gradientTransform', () => {
    const stops = [stop({ offset: '0', 'stop-color': '#ff0' }), stop({ offset: '1', 'stop-color': '#f00' })];
    const radial = (id: string, attributes: Record<string, string>): XastElement => ({
        ...linear(id, stops, attributes),
        name: 'radialGradient',
    });
    const collected = (...els: XastElement[]): string[] => [...collectGradients(els, '#000', noWarn).keys()];

    it('leaves out a linear or radial gradient whose gradientTransform is singular', () => {
        for (const transform of ['scale(0)', 'matrix(0 0 0 0 0 0)', 'scale(2 0)', 'matrix(1 2 2 4 5 6)']) {
            expect(collected(linear('l', stops, { gradientTransform: transform }))).toEqual([]);
            expect(collected(radial('r', { gradientTransform: transform }))).toEqual([]);
        }
    });

    it('applies to a gradientTransform inherited through href', () => {
        const base = linear('base', stops, { gradientTransform: 'scale(0)' });
        expect(collected(base, linear('child', [], { href: '#base' }))).toEqual([]);
        expect(collected(base, linear('own', [], { href: '#base', gradientTransform: 'scale(2)' }))).toEqual(['own']);
    });

    it('keeps a tiny but invertible gradientTransform', () => {
        expect(collected(radial('r', { gradientTransform: 'scale(1e-6)' }))).toEqual(['r']);
    });

    it('lets the paint use its fallback color, or report the reference, end to end', () => {
        const svg = (fill: string, stroke = 'none'): string =>
            `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">` +
            `<linearGradient id="g" gradientTransform="scale(0)"><stop stop-color="#f00"/></linearGradient>` +
            `<rect width="24" height="24" fill="${fill}" stroke="${stroke}"/></svg>`;
        const withFallback = convert(svg('url(#g) #00f'));
        expect(withFallback.xml).toContain('android:fillColor="#FF0000FF"');
        expect(withFallback.xml).not.toContain('<gradient');
        expect(withFallback.warnings).toEqual([]);
        // No fallback: the reference is reported like an unknown one (SVG 2 paints nothing).
        expect(convert(svg('none', 'url(#g)')).warnings.map((w) => w.code)).toEqual(['missing-gradient']);
    });
});

describe('wpt reproductions render like their wpt reference', () => {
    const repro = (name: string): string =>
        readFileSync(fileURLToPath(new URL(`wpt-repro/${name}`, import.meta.url)), 'utf8');
    const cases: [file: string, reference: string][] = [
        [
            // reference/gradient-objectBoundingBox-absolute-units-ref.svg: x2="96" instead of "1in"
            'wpt-gradient-bbox-absolute-units.svg',
            repro('wpt-gradient-bbox-absolute-units.svg').replace('x2="1in"', 'x2="96"'),
        ],
        [
            // reference/green-100x100.svg, sized like the reproduction
            'wpt-gradient-transform-singular.svg',
            '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="green"/></svg>',
        ],
    ];

    for (const [file, reference] of cases) {
        for (const optimize of [true, false]) {
            it(`${file} (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(repro(file), { optimize, strict: true });
                expect(warnings).toEqual([]);
                const result = compareSvgs(reference, vdToSvg(xml));
                expect(result.sizeMismatch).toBeNull();
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });
        }
    }
});

describe('collectGradients — empty or invalid attributes do not block href inheritance', () => {
    const svg = (defs: string, shape = '<rect width="100" height="100" fill="url(#g)"/>'): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${shape}</svg>`;
    const coords = (xml: string): string => xml.match(/<gradient\s[^>]*>/)![0].replace(/\s+/g, ' ');
    const both = (input: string): string[] => [true, false].map((optimize) => coords(convert(input, { optimize }).xml));
    const stops = '<stop offset="0" stop-color="green"/><stop offset="1" stop-color="red"/>';

    // wpt pservers/reftests/{linear,radial}-gradient-transform-empty-attr.svg
    it('inherits the template gradientTransform under gradientTransform="" (linear), in both modes', () => {
        const input = svg(
            `<linearGradient id="t" gradientTransform="translate(1,0)">${stops}</linearGradient>` +
                '<linearGradient id="g" href="#t" gradientTransform=""/>',
        );
        for (const g of both(input)) expect(g).toContain('android:startX="100" android:startY="0" android:endX="200"');
    });

    it('inherits the template gradientTransform under gradientTransform="" (radial), in both modes', () => {
        const input = svg(
            `<radialGradient id="t" gradientTransform="translate(0,-2)">${stops}</radialGradient>` +
                '<radialGradient id="g" xlink:href="#t" gradientTransform="" xmlns:xlink="http://www.w3.org/1999/xlink"/>',
        );
        for (const g of both(input)) expect(g).toContain('android:centerX="50" android:centerY="-150"');
    });

    it('treats an invalid value like an empty one, for every inherited attribute', () => {
        const cases: [template: string, own: string, expected: string][] = [
            ['gradientTransform="translate(1,0)"', 'gradientTransform="foo"', 'android:startX="100"'],
            ['x2="0.5"', 'x2=""', 'android:endX="50"'],
            ['x2="0.5"', 'x2="abc"', 'android:endX="50"'],
            ['gradientUnits="userSpaceOnUse" x2="50"', 'gradientUnits=""', 'android:endX="50"'],
            ['gradientUnits="userSpaceOnUse" x2="50"', 'gradientUnits="bogus"', 'android:endX="50"'],
            ['spreadMethod="reflect" x2="0.5"', 'spreadMethod=""', 'android:tileMode="mirror"'],
            ['spreadMethod="reflect" x2="0.5"', 'spreadMethod="Reflect"', 'android:tileMode="mirror"'],
        ];
        for (const [template, own, expected] of cases) {
            const input = svg(
                `<linearGradient id="t" ${template}>${stops}</linearGradient><linearGradient id="g" href="#t" ${own}/>`,
            );
            for (const g of both(input)) expect(g, own).toContain(expected);
        }
    });

    it('still lets a valid value override the template', () => {
        const input = (own: string): string =>
            svg(
                `<linearGradient id="t" gradientTransform="translate(1,0)" x2="0.5">${stops}</linearGradient>` +
                    `<linearGradient id="g" href="#t" ${own}/>`,
            );
        for (const g of both(input('gradientTransform="scale(2)"'))) expect(g).toContain('android:startX="0"');
        for (const g of both(input('x2="1"')))
            expect(g).toContain('android:startX="100" android:startY="0" android:endX="200"');
    });

    it('keeps the initial value for an invalid attribute without a template', () => {
        const input = svg(
            `<linearGradient id="g" x2="abc" gradientUnits="bogus" gradientTransform="foo">${stops}</linearGradient>`,
        );
        for (const g of both(input))
            expect(g).toContain('android:startX="0" android:startY="0" android:endX="100" android:endY="0"');
    });

    // Chrome and Firefox render x1="10abc" like x1="abc" (initial value 0): the leading number is not kept.
    it('drops a number followed by garbage (10abc) like any invalid value, without a warning', () => {
        const input = svg(
            `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10abc" x2="20">${stops}</linearGradient>`,
        );
        for (const optimize of [true, false]) {
            const { xml, warnings } = convert(input, { optimize });
            expect(coords(xml)).toContain('android:startX="0" android:startY="0" android:endX="20"');
            expect(warnings).toEqual([]);
        }
    });

    it('inherits the template value under x1="10abc", in both modes', () => {
        const input = svg(
            `<linearGradient id="t" gradientUnits="userSpaceOnUse" x1="10" x2="20">${stops}</linearGradient>` +
                '<linearGradient id="g" href="#t" x1="10abc"/>',
        );
        for (const optimize of [true, false]) {
            const { xml, warnings } = convert(input, { optimize });
            expect(coords(xml)).toContain('android:startX="10" android:startY="0" android:endX="20"');
            expect(warnings).toEqual([]);
        }
    });

    it('keeps a valid length it cannot resolve, with its warning (1ex: leading number, calc(): initial value)', () => {
        const cases: [own: string, expected: string, used: string][] = [
            ['x1="1ex"', 'android:startX="1"', 'its leading number is used'],
            ['x1="calc(10px)"', 'android:startX="0"', 'the initial value is used'],
        ];
        for (const [own, expected, used] of cases) {
            const input = svg(
                `<linearGradient id="t" gradientUnits="userSpaceOnUse" x1="5" x2="20">${stops}</linearGradient>` +
                    `<linearGradient id="g" href="#t" ${own}/>`,
            );
            for (const optimize of [true, false]) {
                const { xml, warnings } = convert(input, { optimize });
                expect(coords(xml), own).toContain(expected);
                expect(warnings, own).toEqual([
                    expect.objectContaining({ code: 'unsupported-attribute', message: expect.stringContaining(used) }),
                ]);
            }
        }
    });
});

/** 16 alternating white / black stops: their linearRGB blend needs more items than the cap allows. */
const STRIPES = Array.from(
    { length: 16 },
    (_, i) => `<stop offset="${(i + 1) / 16}" stop-color="${i % 2 ? 'black' : 'white'}"/>`,
).join('');

describe('gradient features VectorDrawable cannot express are reported on use', () => {
    const svg = (defs: string, shapes = '<rect width="100" height="100" fill="url(#g)"/>'): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${defs}</defs>${shapes}</svg>`;
    const codes = (input: string, optimize: boolean): string[] =>
        convert(input, { optimize }).warnings.map((w) => w.code);

    it('replaces an unparseable stop-color with black and reports unsupported-paint', () => {
        const input = svg(
            '<linearGradient id="g"><stop offset="0" stop-color="nonsense"/><stop offset="1" stop-color="red"/></linearGradient>',
        );
        for (const optimize of [true, false]) {
            const { xml, warnings } = convert(input, { optimize });
            expect(xml).toContain('<item android:offset="0" android:color="#FF000000" />');
            expect(xml).toContain('<item android:offset="1" android:color="#FFFF0000" />');
            expect(warnings).toEqual([
                expect.objectContaining({
                    code: 'unsupported-paint',
                    node: 'stop',
                    message: expect.stringContaining('"nonsense"'),
                }),
            ]);
        }
    });

    it('keeps the stop-opacity on the black replacement', () => {
        const stops = collectGradients(
            [linear('g', [stop({ offset: '0', 'stop-color': 'nonsense', 'stop-opacity': '0.5' })])],
            '#000',
            noWarn,
        ).get('g')?.stops;
        expect(stops?.[0]?.color).toBe('#80000000');
    });

    it('reports color-interpolation="linearRGB" it cannot match (a stop mapped to a color resource)', () => {
        const input = svg(
            '<linearGradient id="g" color-interpolation="linearRGB"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="blue"/></linearGradient>',
        );
        for (const optimize of [true, false]) {
            expect(codes(input, optimize)).toEqual([]);
            const { warnings } = convert(input, { optimize, colorMap: { blue: '@color/sea' } });
            expect(warnings.map((w) => w.code)).toEqual(['gradient-approximated']);
            expect(warnings[0]?.message).toContain('color-interpolation="linearRGB"');
        }
    });

    it('reports SMIL animations in a gradient, its stops or its template as unsupported-element, once per message', () => {
        const input = svg(
            '<linearGradient id="t"><animate attributeName="x2" to="0.5" dur="1s"/></linearGradient>' +
                '<linearGradient id="g" href="#t"><set attributeName="y2" to="1"/>' +
                '<stop offset="0" stop-color="green"><animate attributeName="stop-color" to="blue" dur="1s"/></stop>' +
                '<stop offset="1" stop-color="red"/></linearGradient>',
        );
        for (const optimize of [true, false]) {
            const { warnings } = convert(input, { optimize });
            expect(warnings.map((w) => [w.code, w.node])).toEqual([
                ['unsupported-element', 'set'],
                // The template's <animate> and the stop's say the same thing about "g": reported once.
                ['unsupported-element', 'animate'],
            ]);
        }
    });

    it('reports once per gradient, however many shapes use it, and not at all when it is unused', () => {
        const defs = `<linearGradient id="g" color-interpolation="linearRGB"><stop offset="0" stop-color="nonsense"/>${STRIPES}</linearGradient>`;
        const twice =
            '<rect width="40" height="40" fill="url(#g)"/><rect x="50" width="40" height="40" fill="none" stroke="url(#g)"/>';
        for (const optimize of [true, false]) {
            expect(codes(svg(defs, twice), optimize)).toEqual(['unsupported-paint', 'gradient-approximated']);
            expect(codes(svg(defs, '<rect width="10" height="10"/>'), optimize)).toEqual([]);
        }
    });

    it('reports for an elliptical radial drawn exactly in a group too', () => {
        const input = svg(
            `<radialGradient id="g" gradientTransform="scale(1 0.5)" color-interpolation="linearRGB">${STRIPES}</radialGradient>`,
        );
        for (const optimize of [true, false]) {
            const { xml, warnings } = convert(input, { optimize });
            expect(xml).toContain('android:scaleY="0.5"');
            expect(warnings.map((w) => w.code)).toEqual(['gradient-approximated']);
        }
    });
});

describe('color-interpolation="linearRGB" — intermediate stops in linear light', () => {
    const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const toEncoded = (l: number): number => (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055);
    const channels = (color: string): number[] => [1, 3, 5, 7].map((i) => parseInt(color.slice(i, i + 2), 16));
    /** Exact linearRGB blend of two `#AARRGGBB` colors at t, 0–255 per channel. */
    const blend = (a: string, b: string, t: number): number[] => {
        const ca = channels(a);
        const cb = channels(b);
        return ca.map((c, k) => {
            if (k === 0) return c + (cb[k]! - c) * t;
            const l = toLinear(c / 255) + (toLinear(cb[k]! / 255) - toLinear(c / 255)) * t;
            return 255 * toEncoded(l);
        });
    };
    /** sRGB (VectorDrawable) interpolation of `stops` at offset x, 0–255 per channel. */
    const srgbAt = (stops: { offset: number; color: string }[], x: number): number[] => {
        const i = stops.findIndex((s) => s.offset >= x);
        if (i <= 0) return channels(stops[Math.max(i, 0)]!.color);
        const a = stops[i - 1]!;
        const b = stops[i]!;
        const t = b.offset > a.offset ? (x - a.offset) / (b.offset - a.offset) : 1;
        return channels(a.color).map((c, k) => c + (channels(b.color)[k]! - c) * t);
    };

    it('samples black → white in linear light, within 1 % everywhere, with few stops', () => {
        const stops = linearRgbStops([
            { offset: 0, color: '#FF000000' },
            { offset: 1, color: '#FFFFFFFF' },
        ])!;
        expect(stops.length).toBeLessThanOrEqual(10);
        expect(stops.length).toBeGreaterThan(2);
        expect(stops[0]).toEqual({ offset: 0, color: '#FF000000' });
        expect(stops.at(-1)).toEqual({ offset: 1, color: '#FFFFFFFF' });
        for (const [i, s] of stops.entries()) {
            if (i > 0) expect(s.offset).toBeGreaterThan(stops[i - 1]!.offset);
            // every intermediate stop is the exact blend at its offset, rounded to 8 bits
            expect(channels(s.color)).toEqual(blend('#FF000000', '#FFFFFFFF', s.offset).map(Math.round));
        }
        let worst = 0;
        for (let x = 0; x <= 1; x += 1 / 1024) {
            const exact = blend('#FF000000', '#FFFFFFFF', x);
            srgbAt(stops, x).forEach((c, k) => (worst = Math.max(worst, Math.abs(c - exact[k]!))));
        }
        expect(worst).toBeLessThan(2.55);
        // the declared stops alone are far off: mid-gray is 188 in linear light, 128 in sRGB
        expect(Math.round(blend('#FF000000', '#FFFFFFFF', 0.5)[1]!)).toBe(188);
    });

    it('interpolates alpha linearly and adds nothing to a segment already within tolerance', () => {
        expect(
            linearRgbStops([
                { offset: 0, color: '#FF102030' },
                { offset: 1, color: '#80112131' },
            ]),
        ).toEqual([
            { offset: 0, color: '#FF102030' },
            { offset: 1, color: '#80112131' },
        ]);
    });

    it('adds nothing to a hard stop (two stops at the same offset)', () => {
        const stops = [
            { offset: 0, color: '#FFFF0000' },
            { offset: 0.5, color: '#FFFF0000' },
            { offset: 0.5, color: '#FF0000FF' },
            { offset: 1, color: '#FF0000FF' },
        ];
        expect(linearRgbStops(stops)).toEqual(stops);
    });

    it('gives up on a color resource reference or beyond the stop cap', () => {
        expect(
            linearRgbStops([
                { offset: 0, color: '@color/brand' },
                { offset: 1, color: '#FFFFFFFF' },
            ]),
        ).toBeNull();
        const stripes = Array.from({ length: 16 }, (_, i) => ({
            offset: (i + 1) / 16,
            color: i % 2 ? '#FF000000' : '#FFFFFFFF',
        }));
        expect(linearRgbStops(stripes)).toBeNull();
    });

    it('leaves sRGB, auto, initial and invalid values exactly as declared', () => {
        const declared = [stop({ offset: '0', 'stop-color': 'black' }), stop({ offset: '1', 'stop-color': 'white' })];
        for (const value of [undefined, 'sRGB', 'auto', 'initial', 'bogus']) {
            const attrs: Record<string, string> = value ? { 'color-interpolation': value } : {};
            expect(stopsOf(linear('g', declared, attrs))).toEqual([
                { offset: 0, color: '#FF000000' },
                { offset: 1, color: '#FFFFFFFF' },
            ]);
        }
    });

    describe('inheritance of the property', () => {
        const declared = (): XastElement[] => [
            stop({ offset: '0', 'stop-color': 'black' }),
            stop({ offset: '1', 'stop-color': 'white' }),
        ];
        const group = (attributes: Record<string, string>, children: XastElement[]): XastElement => ({
            type: 'element',
            name: 'g',
            attributes,
            children,
        });
        /** Stop count of gradient `id` collected under `root`. */
        const countIn = (root: XastElement, els: XastElement[], id = 'g'): number | undefined =>
            collectGradients(els, '#000', noWarn, undefined, root).get(id)?.stops.length;

        it('is inherited from a document ancestor (attribute or style)', () => {
            for (const attrs of <Record<string, string>[]>[
                { 'color-interpolation': 'linearRGB' },
                { style: 'color-interpolation:linearRGB' },
            ]) {
                const g = linear('g', declared());
                const root = group({}, [group(attrs, [group({}, [g])])]);
                expect(countIn(root, [g])).toBeGreaterThan(2);
                // without the document, only the element itself is read
                expect(collectGradients([g], '#000', noWarn).get('g')?.stops.length).toBe(2);
            }
        });

        it('lets the nearest value win, and defers inherit / unset / invalid values to the parent', () => {
            const own = linear('g', declared(), { 'color-interpolation': 'sRGB' });
            expect(countIn(group({ 'color-interpolation': 'linearRGB' }, [own]), [own])).toBe(2);
            for (const value of ['inherit', 'unset', 'bogus']) {
                const g = linear('g', declared(), { 'color-interpolation': value });
                expect(countIn(group({ 'color-interpolation': 'linearRGB' }, [g]), [g])).toBeGreaterThan(2);
            }
        });

        it('does not flow through href: the referencing gradient decides', () => {
            const template = linear('t', declared(), { 'color-interpolation': 'linearRGB' });
            const g = linear('g', [], { href: '#t' });
            const root = group({}, [template, g]);
            expect(countIn(root, [template, g], 't')).toBeGreaterThan(2);
            expect(countIn(root, [template, g])).toBe(2);
            const plain = linear('t', declared());
            const linearRef = linear('g', [], { href: '#t', 'color-interpolation': 'linearRGB' });
            expect(countIn(group({}, [plain, linearRef]), [plain, linearRef])).toBeGreaterThan(2);
        });
    });

    // wpt pservers/reftests/gradient-color-interpolation.svg. Its root has no size (rejected in strict
    // mode), so it is rendered here with a viewBox. resvg ignores color-interpolation, so the reference
    // is the exact linear-light blend drawn with 256 sRGB stops per segment.
    describe('wpt gradient-color-interpolation.svg renders like its linear-light reference', () => {
        const colors = [
            [0, '#FFFFFFFF'],
            [0.33, '#FF0000FF'],
            [0.66, '#FFFF0000'],
            [1, '#FFFFFF00'],
        ] as const;
        const gradient = (attrs: string, stops: string): string =>
            '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 240 240"><defs>' +
            `<linearGradient id="gradientLinearRGB" gradientUnits="objectBoundingBox"${attrs}>${stops}</linearGradient></defs>` +
            '<rect x="20" y="20" width="200" height="200" style="fill:url(#gradientLinearRGB)"/></svg>';
        const declared =
            '<stop offset="0" stop-color="white"/><stop offset=".33" stop-color="blue"/>' +
            '<stop offset=".66" stop-color="red"/><stop offset="1" stop-color="yellow"/>';
        const source = gradient(' color-interpolation="linearRGB"', declared);
        const rgb = (c: number[]): string =>
            '#' +
            c
                .slice(1)
                .map((v) => Math.round(v).toString(16).padStart(2, '0'))
                .join('');
        const dense = colors.slice(1).flatMap(([o1, c1], i) => {
            const [o0, c0] = colors[i]!;
            return Array.from({ length: 257 }, (_, k) => {
                const t = k / 256;
                return `<stop offset="${o0 + (o1 - o0) * t}" stop-color="${rgb(blend(c0, c1, t))}"/>`;
            });
        });
        const reference = gradient('', dense.join(''));
        /** 3 ≈ 1 % of a channel: far stricter than the default visual tolerance. */
        const TIGHT = 3;

        for (const optimize of [true, false]) {
            it(`within 1 % of the reference (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(source, { optimize, strict: true });
                expect(warnings).toEqual([]);
                const result = compareSvgs(reference, vdToSvg(xml), TIGHT);
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
                // the plain sRGB rendering is far off at the same tolerance
                const srgb = convert(gradient('', declared), { optimize }).xml;
                expect(compareSvgs(reference, vdToSvg(srgb), TIGHT).mismatch).toBeGreaterThan(0.3);
            });
        }

        // convert() passes the root to collectGradients: the property inherited from an ancestor applies.
        for (const optimize of [true, false]) {
            it(`inherits color-interpolation from the root <svg> through convert() (optimize: ${optimize})`, () => {
                const inherited = gradient('', declared).replace('<svg ', '<svg color-interpolation="linearRGB" ');
                const { xml, warnings } = convert(inherited, { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(compareSvgs(reference, vdToSvg(xml), TIGHT).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });
        }
    });
});

describe('invalid gradientTransform is reported (T-88)', () => {
    const svg = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;
    const STOPS = '<stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/>';
    const direct = (value: string): string =>
        svg(
            `<linearGradient id="g" gradientTransform="${value}">${STOPS}</linearGradient><rect width="24" height="24" fill="url(#g)"/>`,
        );
    const viaHref = (value: string): string =>
        svg(
            `<linearGradient id="t" gradientTransform="rotate(90)">${STOPS}</linearGradient>` +
                `<linearGradient id="g" href="#t" gradientTransform="${value}"/><rect width="24" height="24" fill="url(#g)"/>`,
        );
    const INVALID = ['rotate(foo)', 'translate(10px 0)', 'translate(foo 5) rotate(90)'];
    const ignored = (value: string): Warning => ({
        code: 'unsupported-attribute',
        message: `Gradient "g" has gradientTransform="${value}", not a valid transform list; ignored.`,
        node: 'linearGradient',
    });
    const endpoints = (xml: string): string[] =>
        ['startX', 'startY', 'endX', 'endY'].map((k) => new RegExp(`android:${k}="([^"]*)"`).exec(xml)![1]!);

    for (const optimize of [true, false]) {
        describe(`optimize: ${optimize}`, () => {
            for (const value of INVALID) {
                it(`reports ${value} on a gradient and renders it untransformed`, () => {
                    const { xml, warnings } = convert(direct(value), { optimize });
                    expect(warnings).toEqual([ignored(value)]);
                    expect(xml).toBe(convert(direct(''), { optimize }).xml);
                    expect(() => convert(direct(value), { optimize, strict: true })).toThrow(/gradientTransform/);
                });

                it(`reports ${value} on a gradient whose template's gradientTransform then applies`, () => {
                    const { xml, warnings } = convert(viaHref(value), { optimize });
                    expect(warnings).toEqual([ignored(value)]);
                    expect(endpoints(xml)).toEqual(['0', '0', '0', '24']); // the template's rotate(90)
                    expect(() => convert(viaHref(value), { optimize, strict: true })).toThrow(/gradientTransform/);
                });
            }

            it('reports an invalid gradientTransform once for a gradient used twice', () => {
                const doc = svg(
                    `<linearGradient id="g" gradientTransform="rotate(foo)">${STOPS}</linearGradient>` +
                        '<rect width="12" height="24" fill="url(#g)"/><rect x="12" width="12" height="24" fill="url(#g)"/>',
                );
                expect(convert(doc, { optimize }).warnings).toEqual([ignored('rotate(foo)')]);
            });

            it('does not report an empty or valid gradientTransform', () => {
                expect(convert(direct(''), { optimize, strict: true }).warnings).toEqual([]);
                expect(convert(viaHref(''), { optimize, strict: true }).warnings).toEqual([]);
                const { xml, warnings } = convert(direct('rotate(90 12 12)'), { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(xml).not.toBe(convert(direct(''), { optimize }).xml);
            });
        });
    }
});
