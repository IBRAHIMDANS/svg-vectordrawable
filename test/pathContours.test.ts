import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { enclosesArea, evenOddToNonZero, windingSign } from '../src/pathContours.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';
import { vdToSvg } from './visual/vdToSvg.js';

const MODES = [true, false] as const;
const svg = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;
const doc = (d: string, rule: string): string => svg(`<path d="${d}" fill-rule="${rule}"/>`);

/** Rewrites `d`, checks the nonzero result renders like the evenodd source, returns it. */
function expectEquivalent(d: string, orientation?: 1 | -1): string {
    const out = evenOddToNonZero(d, orientation);
    expect(out).not.toBeNull();
    const result = compareSvgs(doc(d, 'evenodd'), doc(out!, 'nonzero'));
    expect(result.inked).toBeGreaterThan(0);
    expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
    return out!;
}

/** The source really depends on its fill rule (the test would prove nothing otherwise). */
const expectRuleMatters = (d: string): void =>
    expect(compareSvgs(doc(d, 'evenodd'), doc(d, 'nonzero')).mismatch).toBeGreaterThan(0.05);

/** The VectorDrawable renders like the source, without any warning (strict included), in both modes. */
function expectConverted(source: string): string[] {
    return MODES.map((optimize) => {
        const { xml, warnings } = convert(source, { optimize, strict: true });
        expect(warnings).toEqual([]);
        const result = compareSvgs(source, vdToSvg(xml));
        expect(result.sizeMismatch).toBeNull();
        expect(result.inked).toBeGreaterThan(0);
        expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        return xml;
    });
}

// Hole touching the outer contour along an edge (the T-76 reproduction), scaled to the 24 viewBox.
const EDGE_HOLE = 'M2 2H22V22H2ZM2 7H12V17H2Z';
// A diamond hole touching the four sides of its square at single points.
const DIAMOND_HOLE = 'M2 2h20v20H2zM12 2L22 12L12 22L2 12z';

describe('evenOddToNonZero: touching contours (T-76)', () => {
    it.each([
        ['a hole touching its outer contour along an edge', EDGE_HOLE],
        ['a hole touching its outer contour at points', DIAMOND_HOLE],
        ['a triangular hole with one vertex on the outer contour', 'M2 2h20v20H2zM12 2L18 14H6z'],
        ['a hole sharing a corner with its outer contour', 'M2 2h20v20H2zM2 2h8v8H2z'],
        ['a hole touching a hole-in-hole', 'M2 2h20v20H2zM5 5h14v14H5zM5 9h6v6H5z'],
    ])('reverses %s instead of refusing it', (_, d) => {
        expectRuleMatters(d);
        const out = expectEquivalent(d);
        expect(out).not.toBe(d);
        expect(windingSign(out)).toBe(1);
    });

    it.each([
        ['squares sharing an edge', 'M2 2h10v10H2zM12 2h10v10H12z'],
        ['squares sharing part of an edge', 'M2 2h10v10H2zM12 6h10v10H12z'],
        ['squares touching at a corner', 'M2 2h10v10H2zM12 12h10v10H12z'],
        ['triangles meeting at a vertex (Figma export)', 'm12 9 12-9H0zm0 0L0 18h24z'],
        ['a contour whose lobes meet at a vertex (Figma export)', 'M0 0h24L0 9l24 9H0z'],
        ['a keyhole: the hole joined to the outer contour by a bridge', 'M2 2H22V22H2V12H7V17H17V7H7V12H2Z'],
    ])('returns %s unchanged (already well oriented)', (_, d) => {
        expect(evenOddToNonZero(d)).toBe(d);
        expectEquivalent(d);
    });

    it('orients touching disjoint shapes the same way when asked', () => {
        const d = 'm12 9 12-9H0zm0 0L0 18h24z';
        expect(windingSign(d)).toBe(-1);
        expect(windingSign(expectEquivalent(d, 1))).toBe(1);
    });

    it.each([
        ['overlapping squares', 'M2 2h12v12H2zM8 8h12v12H8z'],
        ['a shape crossing a square through two of its vertices', 'M2 2H12V12H2ZM12 7L8 4L12 2L16 4Z'],
        ['a contour touching itself, its inner loop turning the same way', 'M2 2h20v20H12V12H22V22H2z'],
        ['a keyhole whose hole turns the same way as its outer contour', 'M2 2H22V22H2V12H7V7H17V17H7V12H2Z'],
        ['a self-intersecting figure-eight', 'M2 2L22 22H2L22 2z'],
        ['the same square twice', 'M2 2h10v10H2zM2 2h10v10H2z'],
    ])('still refuses %s', (_, d) => {
        expect(evenOddToNonZero(d)).toBeNull();
    });

    it('keeps a stroke-safe rewrite: every closed contour kept', () => {
        const out = evenOddToNonZero(EDGE_HOLE)!;
        expect(out.match(/Z/g)).toHaveLength(2);
    });
});

describe('windingSign: touching contours', () => {
    it('proves the sign of nested touching contours of opposite orientations', () => {
        expect(windingSign('M2 2h20v20H2zM2 7v10h10V7z')).toBe(1); // hole wound back: 1 then 0
        expect(windingSign('M2 2v20h20V2zM2 7h10v10H2z')).toBe(-1);
    });

    it('rejects touching disjoint contours of opposite orientations', () => {
        expect(windingSign('M2 2h10v10H2zM12 2v10h10V2z')).toBeNull();
    });
});

describe('touching evenodd contours through convert (T-76)', () => {
    const SQUARE = '<path d="M0 0h24v24H0z" fill="#E53935"';

    it.each([
        ['a hole touching the edge', EDGE_HOLE],
        ['a hole touching at points', DIAMOND_HOLE],
        ['squares sharing an edge', 'M2 2h10v10H2zM12 2h10v10H12z'],
    ])('clips with an evenodd clip-path: %s', (_, d) => {
        const source = svg(
            `<clipPath id="c"><path clip-rule="evenodd" d="${d}"/></clipPath>${SQUARE} clip-path="url(#c)"/>`,
        );
        for (const xml of expectConverted(source)) expect(xml).toContain('<clip-path ');
    });

    it('masks with evenodd content: a hole touching the edge', () => {
        const source = svg(
            `<mask id="m"><path d="${EDGE_HOLE}" fill="#fff" fill-rule="evenodd"/></mask>${SQUARE} mask="url(#m)"/>`,
        );
        for (const xml of expectConverted(source)) {
            expect(xml).not.toContain('mask');
            expect(xml).toContain('<clip-path ');
        }
    });

    it('drops fillType="evenOdd" below API 24 for a hole touching the edge', () => {
        const source = svg(`<path d="${EDGE_HOLE}" fill="#E53935" fill-rule="evenodd"/>`);
        for (const optimize of MODES) {
            const { xml, warnings } = convert(source, { optimize, minSdk: 21 });
            expect(warnings).toEqual([]);
            expect(xml).not.toContain('fillType');
            const result = compareSvgs(source, vdToSvg(xml));
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        }
    });

    it('keeps the warning for a crossing evenodd clip-path', () => {
        const source = svg(
            `<clipPath id="c"><path clip-rule="evenodd" d="M2 2h12v12H2zM8 8h12v12H8z"/></clipPath>${SQUARE} clip-path="url(#c)"/>`,
        );
        for (const optimize of MODES)
            expect(convert(source, { optimize }).warnings.map((w) => w.message)).toEqual([
                expect.stringMatching(/crossing contours/),
            ]);
    });
});

// Real icons whose contour ends a hair off its start: heroicons solid `equals` ends its second contour
// at y = 15.749 for a start at 15.75; bootstrap `chevron-bar-up` closes by float error only.
const EQUALS =
    'M3.748 8.248a.75.75 0 0 1 .75-.75h15a.75.75 0 0 1 0 1.5h-15a.75.75 0 0 1-.75-.75ZM3.748 15.75a.75.75 0 0 1 .75-.751h15a.75.75 0 0 1 0 1.5h-15a.75.75 0 0 1-.75-.75Z';
const CHEVRON_BAR_UP =
    'M3.646 11.854a.5.5 0 0 0 .708 0L8 8.207l3.646 3.647a.5.5 0 0 0 .708-.708l-4-4a.5.5 0 0 0-.708 0l-4 4a.5.5 0 0 0 0 .708M2.4 5.2c0 .22.18.4.4.4h10.4a.4.4 0 0 0 0-.8H2.8a.4.4 0 0 0-.4.4';
// bootstrap `sort-numeric-down`, the digit 9: a hole whose closing offset is ~1.5 flattening tolerances.
const NINE =
    'M11.36 14.098c-1.137 0-1.708-.657-1.762-1.278h1.004c.058.223.343.45.773.45.824 0 1.164-.829 1.133-1.856h-.059c-.148.39-.57.742-1.261.742-.91 0-1.72-.613-1.72-1.758 0-1.148.848-1.835 1.973-1.835 1.09 0 2.063.636 2.063 2.687 0 1.867-.723 2.848-2.145 2.848zm.062-2.735c.504 0 .933-.336.933-.972 0-.633-.398-1.008-.94-1.008-.52 0-.927.375-.927 1 0 .64.418.98.934.98';

describe('evenOddToNonZero: contours closing a hair off their start (T-118)', () => {
    it.each([
        ['equals (closing offset 1e-3)', EQUALS],
        ['chevron-bar-up (float error)', CHEVRON_BAR_UP],
        ['the digit 9 of sort-numeric-down', NINE],
    ])('accepts %s', (_, d) => {
        expectEquivalent(d);
    });

    it('reverses a hole closing a hair off its start (its fill rule matters)', () => {
        // The second bar of `equals` as a hole of a square turning the same way.
        const d = 'M2 2h20v20H2zM3.748 15.75a.75.75 0 0 1 .75-.751h15a.75.75 0 0 1 0 1.5h-15a.75.75 0 0 1-.75-.75Z';
        expectRuleMatters(d);
        expect(expectEquivalent(d)).not.toBe(d);
    });

    it('keeps a contour smaller than the closing tolerance in the rewrite', () => {
        // tol ≈ 2.8 here: the 0.5 square lies within 2·tol of its start, yet must be written back.
        const d = 'M0 0h20000v20000H0zM100 100h19800v19800H100zM50 50h.5v.5h-.5z';
        const out = evenOddToNonZero(d)!;
        expect(out).not.toBe(d);
        expect(out.match(/z/gi)).toHaveLength(3);
    });

    it.each([
        ['a bow tie ending 1e-3 short of its start', 'M2 2L22 22V2L2 22L2 2.001'],
        ['an S curve crossing its closing line, ending 1e-3 off its start', 'M2 12C2 -4 22 30 22 12L2.001 12Z'],
        ['a figure-eight of lines closed by float error', 'M2 2L22 22H2L22 2L2.0000000001 2z'],
    ])('still refuses %s', (_, d) => {
        expect(evenOddToNonZero(d)).toBeNull();
    });

    it.each([
        ['equals', svg(`<path fill-rule="evenodd" d="${EQUALS}"/>`)],
        ['chevron-bar-up', svg(`<path fill-rule="evenodd" d="${CHEVRON_BAR_UP}"/>`)],
        ['sort-numeric-down', svg(`<path fill-rule="evenodd" d="${NINE}"/>`)],
    ])('drops fillType="evenOdd" below API 24 for %s, rendering unchanged', (_, source) => {
        for (const optimize of MODES) {
            const { xml, warnings } = convert(source, { optimize, minSdk: 21 });
            expect(warnings).toEqual([]);
            expect(xml).not.toContain('fillType');
            const result = compareSvgs(source, vdToSvg(xml));
            expect(result.inked).toBeGreaterThan(0);
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        }
    });
});

describe('enclosesArea: whether a fill can cover anything (T-157)', () => {
    it.each([
        ['M0 0L10 10', 'a line'],
        ['M0 0H10H5', 'an open flat polyline'],
        ['M0 0H10H5Z', 'a closed flat polyline'],
        ['M0 0C2 2 4 4 10 10', 'a cubic with collinear control points'],
        ['M0 0L5 5M0 10H10', 'two flat subpaths on different lines'],
        ['M0 0H10ZV10', 'a segment after Z, flat with the closed subpath start'],
        ['M5 5', 'a moveto alone'],
    ])('false for %s (%s)', (d) => {
        expect(enclosesArea(d)).toBe(false);
    });

    it.each([
        ['M0 0H10V10', 'an open subpath that is not flat (filled as if closed)'],
        ['M0 0L10 10L0 10L10 0Z', 'a figure-eight (signed area 0, two lobes filled)'],
        ['M0 0Q5 5 10 0', 'a quadratic off its chord'],
        ['M0 0A5 5 0 0 1 10 0', 'an arc'],
        ['M0 0H10M0 0H10V10', 'a flat subpath then one with area'],
        ['M0 0H10ZV10H5', 'a segment after Z spanning an area from the closed subpath start'],
    ])('true for %s (%s)', (d) => {
        expect(enclosesArea(d)).toBe(true);
    });
});
