import { describe, expect, it } from 'vitest';
import {
    evenOddToNonZero,
    normalizeArcFlags,
    pathBBox,
    reversePathData,
    transformPathData,
    windingSign,
} from '../src/pathData.js';
import { IDENTITY, type Matrix } from '../src/transform.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';

/** Extracts all numbers from a path string, for tolerant coordinate assertions. */
function nums(d: string): number[] {
    return (d.match(/-?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
}

/** The (x, y) of the very last coordinate pair in a path string. */
function lastPoint(d: string): [number, number] {
    const n = nums(d);
    expect(n.length).toBeGreaterThanOrEqual(2);
    return [n[n.length - 2]!, n[n.length - 1]!];
}

describe('pathBBox', () => {
    it('computes the bbox of a simple closed rectangle', () => {
        expect(pathBBox('M0 0h10v10z')).toEqual({ x: 0, y: 0, width: 10, height: 10 });
    });

    it('handles absolute commands and negative coordinates', () => {
        expect(pathBBox('M-5 -5 L5 5')).toEqual({ x: -5, y: -5, width: 10, height: 10 });
    });

    it('uses the true cubic extrema, not the control points', () => {
        // Control points reach y=20, but the curve itself peaks at 0.75 × 20 = 15.
        const box = pathBBox('M0 0 C5 20 15 20 10 0');
        expect(box).not.toBeNull();
        expect(box!.x).toBe(0);
        expect(box!.y).toBe(0);
        expect(box!.height).toBeCloseTo(15, 6);
        expect(box!.width).toBeGreaterThan(10);
        expect(box!.width).toBeLessThan(15);
    });

    it('uses the true quadratic extremum (half way to the control point)', () => {
        const box = pathBBox('M0 0 Q10 -8 20 0');
        expect(box).not.toBeNull();
        expect(box!.y).toBeCloseTo(-4, 6);
        expect(box!.width).toBe(20);
    });

    it('measures the full extent of an arc, not just its endpoint', () => {
        const box = pathBBox('M0 0 A5 5 0 0 1 10 0');
        expect(box).not.toBeNull();
        expect(box!.width).toBeCloseTo(10, 5);
        expect(box!.height).toBeCloseTo(5, 2);
    });

    it('measures a circle written as two arcs (svgo output)', () => {
        const box = pathBBox('M50 41a9 9 0 1 0 0 18 9 9 0 1 0 0-18');
        expect(box).not.toBeNull();
        expect(box!.x).toBeCloseTo(41, 2);
        expect(box!.y).toBeCloseTo(41, 2);
        expect(box!.width).toBeCloseTo(18, 2);
        expect(box!.height).toBeCloseTo(18, 2);
    });

    it('returns null for an empty path', () => {
        expect(pathBBox('')).toBeNull();
    });

    it('returns null for an invalid / non-geometric path', () => {
        expect(pathBBox('not a path at all')).toBeNull();
        expect(pathBBox('   ')).toBeNull();
    });
});

describe('transformPathData', () => {
    it('scales coordinates by a diagonal matrix', () => {
        const out = transformPathData('M0 0L10 0', { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
        // Expect M0 0 then L20 0.
        expect(nums(out)).toEqual([0, 0, 20, 0]);
        expect(out).toContain('L20 0');
    });

    it('applies a translation via e/f', () => {
        const out = transformPathData('M0 0L10 0', { a: 1, b: 0, c: 0, d: 1, e: 5, f: 7 });
        expect(nums(out)).toEqual([5, 7, 15, 7]);
    });

    it('normalizes relative commands and H/V to absolute L', () => {
        const out = transformPathData('M0 0h10v10', IDENTITY);
        // h10 → L10 0, v10 → L10 10 (current x preserved).
        expect(nums(out)).toEqual([0, 0, 10, 0, 10, 10]);
        expect(out).not.toMatch(/[hvHV]/);
    });

    it('preserves geometry under the identity matrix (no arc)', () => {
        const out = transformPathData('M1 2 L3 4 C5 6 7 8 9 10 Z', IDENTITY);
        expect(nums(out)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(out.trim().endsWith('Z')).toBe(true);
    });

    it('rounds to 3 decimals and trims trailing zeros', () => {
        const out = transformPathData('M0 0 L1 1', { a: 2.5, b: 0, c: 0, d: 2, e: 0, f: 0 });
        // x: 1*2.5 = 2.5 (kept), y: 1*2 = 2 (no ".000").
        expect(out).toContain('L2.5 2');
        expect(out).not.toContain('2.500');
        expect(out).not.toContain('2.000');
    });

    it('converts an arc to cubics, producing a valid non-empty path ending near the arc endpoint', () => {
        const out = transformPathData('M0 0A5 5 0 0 1 10 0', IDENTITY);
        expect(out.length).toBeGreaterThan(0);
        // Arc must be lowered to cubics: no A command remains.
        expect(out).not.toMatch(/[aA]/);
        expect(out).toMatch(/C/);
        const [lx, ly] = lastPoint(out);
        expect(lx).toBeCloseTo(10, 1);
        expect(Math.abs(ly)).toBeLessThanOrEqual(0.5);
    });

    it('still maps arc-derived cubics through the matrix', () => {
        const m: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 };
        const out = transformPathData('M0 0A5 5 0 0 1 10 0', m);
        const [lx] = lastPoint(out);
        // Endpoint (10,0) translated by +100 in x.
        expect(lx).toBeCloseTo(110, 1);
    });
});

describe('arc flag parsing', () => {
    it('reads compact arc flags (`0120` = large-arc 0, sweep 1, x 20)', () => {
        const compact = transformPathData('M2 12a10 10 0 0120 0', IDENTITY);
        const spaced = transformPathData('M2 12a10 10 0 0 1 20 0', IDENTITY);
        expect(compact).toMatch(/C/);
        expect(compact).toBe(spaced);
        const [lx, ly] = lastPoint(compact);
        expect(lx).toBeCloseTo(22, 3);
        expect(ly).toBeCloseTo(12, 3);
    });

    it('computes the bbox of a compact-flag arc (upper half circle)', () => {
        const box = pathBBox('M2 12a10 10 0 0120 0');
        expect(box).not.toBeNull();
        expect(box!.x).toBeCloseTo(2, 3);
        expect(box!.y).toBeCloseTo(2, 3);
        expect(box!.width).toBeCloseTo(20, 3);
        expect(box!.height).toBeCloseTo(10, 3);
    });

    it('leaves the spaced form unchanged', () => {
        const out = transformPathData('M0 0a1 1 0 1 1 2 0', IDENTITY);
        expect(out).toMatch(/C/);
        const [lx, ly] = lastPoint(out);
        expect(lx).toBeCloseTo(2, 3);
        expect(ly).toBeCloseTo(0, 3);
    });

    it('accepts comma-separated and partially compact flags', () => {
        const spaced = transformPathData('M2 12a10 10 0 0 1 20 0', IDENTITY);
        expect(transformPathData('M2 12a10,10,0,0,1,20,0', IDENTITY)).toBe(spaced);
        expect(transformPathData('M2 12a10 10 0 01 20 0', IDENTITY)).toBe(spaced);
    });

    it('reads flags followed by a negative or decimal number', () => {
        const compact = transformPathData('M0 0a1 1 0 01-2.5.5', IDENTITY);
        const spaced = transformPathData('M0 0a1 1 0 0 1 -2.5 0.5', IDENTITY);
        expect(compact).toMatch(/C/);
        expect(compact).toBe(spaced);
        const [lx, ly] = lastPoint(compact);
        expect(lx).toBeCloseTo(-2.5, 3);
        expect(ly).toBeCloseTo(0.5, 3);
    });

    it('reads repeated implicit arc groups with compact flags', () => {
        const compact = transformPathData('M0 0a5 5 0 0110 0 5 5 0 0110 0', IDENTITY);
        const spaced = transformPathData('M0 0a5 5 0 0 1 10 0 5 5 0 0 1 10 0', IDENTITY);
        expect(compact).toBe(spaced);
        const [lx, ly] = lastPoint(compact);
        expect(lx).toBeCloseTo(20, 3);
        expect(ly).toBeCloseTo(0, 3);
        expect(pathBBox('M0 0a5 5 0 0110 0 5 5 0 0110 0')).toEqual(pathBBox('M0 0a5 5 0 0 1 10 0 5 5 0 0 1 10 0'));
    });
});

describe('normalizeArcFlags', () => {
    it('separates compact arc flags with single spaces', () => {
        expect(normalizeArcFlags('M2 12a10 10 0 0120 0')).toBe('M2 12a10 10 0 0 1 20 0');
        expect(normalizeArcFlags('A10 10 0 1020 0')).toBe('A10 10 0 1 0 20 0');
    });

    it('keeps commas and only spaces the flags that touch their neighbours', () => {
        expect(normalizeArcFlags('a10,10,0,0,1,20,0')).toBe('a10,10,0,0,1,20,0');
        expect(normalizeArcFlags('a10,10,0,01,20,0')).toBe('a10,10,0,0 1,20,0');
        expect(normalizeArcFlags('a10,10,0,0,120,0')).toBe('a10,10,0,0,1 20,0');
    });

    it('handles repeated implicit arc groups', () => {
        expect(normalizeArcFlags('M0 0a5 5 0 0110 0 5 5 0 0110 0')).toBe('M0 0a5 5 0 0 1 10 0 5 5 0 0 1 10 0');
    });

    it('separates a negative or decimal number glued to a flag', () => {
        expect(normalizeArcFlags('a1 1 0 01-2.5.5')).toBe('a1 1 0 0 1 -2.5.5');
        expect(normalizeArcFlags('a1 1 0 01.5.5')).toBe('a1 1 0 0 1 .5.5');
        expect(normalizeArcFlags('a1 1 0 0 1-2 3')).toBe('a1 1 0 0 1 -2 3');
    });

    it('leaves the rest of the path untouched', () => {
        expect(normalizeArcFlags('M0,0L5-5a2 2 0 0110 0c1.5.5 2 2 3 3z')).toBe('M0,0L5-5a2 2 0 0 1 10 0c1.5.5 2 2 3 3z');
    });

    it('returns a path without arcs strictly unchanged', () => {
        const d = 'M0,0L5-5c1.5.5 2 2 3 3h01v10z';
        expect(normalizeArcFlags(d)).toBe(d);
    });

    it('returns a path with already separated flags strictly unchanged', () => {
        const d = 'M0.3,0h0.5a0.3,0.3 0 0 1 0.3,0.3 5 5 0 1 0 -2 3';
        expect(normalizeArcFlags(d)).toBe(d);
    });
});

describe('evenOddToNonZero', () => {
    const doc = (d: string, rule: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d}" fill-rule="${rule}"/></svg>`;

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
        expect(compareSvgs(doc(d, 'evenodd'), doc(d, 'nonzero')).mismatch).toBeGreaterThan(0.1);

    it('reverses the hole of a ring whose contours turn the same way', () => {
        const d = 'M2 2h20v20H2zM7 7h10v10H7z';
        expectRuleMatters(d);
        const out = expectEquivalent(d);
        expect(out).not.toBe(d);
        expect(out).toBe('M2 2L22 2L22 22L2 22L2 2ZM7 7L7 17L17 17L17 7L7 7Z');
        expect(windingSign(out)).toBe(1);
    });

    it('returns a ring already oriented by depth unchanged, in both directions', () => {
        for (const d of ['M2 2h20v20H2zM7 7v10h10V7z', 'M2 2v20h20V2zM7 7h10v10H7z'])
            expect(evenOddToNonZero(d)).toBe(d);
    });

    it('forces the outer orientation when asked', () => {
        const d = 'M2 2h20v20H2zM7 7v10h10V7z';
        const out = expectEquivalent(d, -1);
        expect(windingSign(out)).toBe(-1);
        expect(evenOddToNonZero(d, 1)).toBe(d);
    });

    it('alternates the orientation of a 3-level target', () => {
        const d = 'M2 2h20v20H2zM5 5h14v14H5zM8 8h8v8H8z';
        expectRuleMatters(d);
        expect(windingSign(expectEquivalent(d))).toBe(1);
    });

    it('handles two disjoint shapes, each with a hole', () => {
        const d = 'M1 1h10v10H1zM4 4h4v4H4zM13 13h10v10H13zM16 16h4v4h-4z';
        expectRuleMatters(d);
        expectEquivalent(d);
    });

    it('handles curved contours: a circle with a square hole, and the evenodd probe', () => {
        const circle = 'M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0zM9 9v6h6V9z';
        expectRuleMatters(circle);
        expect(windingSign(expectEquivalent(circle))).toBe(-1); // the circle's own (outer) direction is kept
        const probe = 'M12 13a9 9 0 1 0 0.001 0zM12 17a5 5 0 1 0 0.001 0z';
        expectRuleMatters(probe);
        expectEquivalent(probe);
    });

    it('closes open subpaths, as SVG fills them', () => {
        const d = 'M2 2h20v20H2M7 7h10v10H7';
        expectRuleMatters(d);
        const out = expectEquivalent(d);
        expect(out.match(/Z/g)).toHaveLength(2);
    });

    it('starts a subpath without moveto at the previous subpath start', () => {
        expectEquivalent('M2 2h20v20H2zm5 5h10v10H7z');
        expectEquivalent('M2 2h20v20H2zl0 0M7 7h10v10H7z');
    });

    it('ignores contours that enclose nothing', () => {
        const out = expectEquivalent('M2 2h20v20H2zM7 7h10v10H7zM0 0L5 0zM3 3z');
        expect(out).not.toContain('M0 0');
    });

    it.each([
        ['overlapping squares', 'M2 2h12v12H2zM8 8h12v12H8z'],
        ['squares sharing an edge', 'M2 2h10v10H2zM12 2h10v10H12z'],
        ['squares touching at a corner', 'M2 2h10v10H2zM12 12h10v10H12z'],
        ['a hole touching its outer contour', 'M2 2h20v20H2zM2 7h10v10H2z'],
        ['a self-intersecting figure-eight', 'M2 2L22 22H2L22 2z'],
        ['a contour touching itself', 'M2 2h20v20H12V12H22V22H2z'],
        ['overlapping circles', 'M2 12a6 6 0 1 0 12 0a6 6 0 1 0 -12 0zM10 12a6 6 0 1 0 12 0a6 6 0 1 0 -12 0z'],
    ])('returns null for %s', (_, d) => {
        expect(evenOddToNonZero(d)).toBeNull();
    });

    it('gives up (null) beyond the segment cap', () => {
        const many = Array.from({ length: 30_000 }, (_, i) => `M${i} 0h0.5v0.5h-0.5z`).join('');
        expect(evenOddToNonZero(many)).toBeNull();
    });
});

describe('windingSign / reversePathData', () => {
    it('reads the orientation of simple contours (y down: clockwise on screen is positive)', () => {
        expect(windingSign('M0 0h10v10H0z')).toBe(1);
        expect(windingSign('M0 0v10h10V0z')).toBe(-1);
        expect(windingSign('M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0z')).toBe(-1); // circle shape output
        expect(windingSign('M0 0Q10 -10 20 0Q10 10 0 0z')).toBe(1);
    });

    it('accepts overlapping contours turning the same way, and nested holes', () => {
        expect(windingSign('M2 2h12v12H2zM8 8h12v12H8z')).toBe(1);
        expect(windingSign('M2 2h20v20H2zM7 7v10h10V7z')).toBe(1);
    });

    it('returns null when windings may have both signs or the path is degenerate', () => {
        expect(windingSign('M2 2h12v12H2zM8 8v12h12V8z')).toBeNull(); // overlapping, opposite
        expect(windingSign('M1 1h4v4H1zM10 10v4h4v-4z')).toBeNull(); // disjoint, opposite
        expect(windingSign('M2 2L22 22H2L22 2z')).toBeNull();
        expect(windingSign('M0 0L10 0')).toBeNull();
        expect(windingSign('')).toBeNull();
    });

    it('reverses every contour exactly (lines, quadratics, cubics)', () => {
        const d = 'M0 0L10 0Q15 5 10 10C8 12 2 12 0 10z';
        const r = reversePathData(d);
        expect(r).toBe('M0 0L0 10C2 12 8 12 10 10Q15 5 10 0L0 0Z');
        expect(windingSign(r)).toBe(-windingSign(d)!);
        expect(reversePathData(r)).toBe('M0 0L10 0Q15 5 10 10C8 12 2 12 0 10L0 0Z');
    });
});
