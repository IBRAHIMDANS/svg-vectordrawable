import { describe, expect, it } from 'vitest';
import { arcCenter, toAbsolute } from '../src/pathAbsolute.js';
import { parsePath } from '../src/pathParse.js';

/** Point of the arc's ellipse at angle `a`. */
function pointAt(arc: NonNullable<ReturnType<typeof arcCenter>>, a: number): [number, number] {
    const { cx, cy, rx, ry, cosPhi, sinPhi } = arc;
    const x = rx * Math.cos(a);
    const y = ry * Math.sin(a);
    return [cx + cosPhi * x - sinPhi * y, cy + sinPhi * x + cosPhi * y];
}

describe('arcCenter (SVG 2 endpoint → center conversion, B.2.4)', () => {
    it('returns null for a zero radius or coincident end points', () => {
        expect(arcCenter(0, 0, 0, 5, 0, false, true, 10, 0)).toBeNull();
        expect(arcCenter(0, 0, 5, 0, 0, false, true, 10, 0)).toBeNull();
        expect(arcCenter(3, 4, 5, 5, 0, false, true, 3, 4)).toBeNull();
    });

    it('maps theta to the start point and theta + delta to the end point', () => {
        const arc = arcCenter(10, -3, 40, 15, 30, true, false, -20, 12)!;
        const [sx, sy] = pointAt(arc, arc.theta);
        const [ex, ey] = pointAt(arc, arc.theta + arc.delta);
        expect(Math.hypot(sx - 10, sy + 3)).toBeLessThan(1e-12);
        expect(Math.hypot(ex + 20, ey - 12)).toBeLessThan(1e-12);
        // Large arc, sweep 0: negative sweep beyond π.
        expect(arc.delta).toBeLessThan(-Math.PI);
    });

    it('scales radii too small for the chord (lambda > 1) and puts the center exactly at the midpoint', () => {
        // Flattened ellipse 1:50 rotated 17°, far too small for its chord: a half ellipse.
        const x1 = 3.7;
        const y1 = -12.1;
        const x2 = 41.3;
        const y2 = 8.9;
        for (const large of [false, true]) {
            for (const sweep of [false, true]) {
                const arc = arcCenter(x1, y1, 0.5, 0.01, 17, large, sweep, x2, y2)!;
                expect(arc.cx).toBe((x1 + x2) / 2);
                expect(arc.cy).toBe((y1 + y2) / 2);
                expect(arc.rx / arc.ry).toBeCloseTo(50, 10);
                expect(Math.abs(arc.delta)).toBeCloseTo(Math.PI, 12);
                expect(Math.sign(arc.delta)).toBe(sweep ? 1 : -1);
                const [ex, ey] = pointAt(arc, arc.theta + arc.delta);
                expect(Math.hypot(ex - x2, ey - y2)).toBeLessThan(1e-9);
            }
        }
    });

    it('returns null, never NaN, when den underflows to 0 (no sqrt(0 / 0)) or the squares overflow', () => {
        // End points 1e-170 apart: x1'² underflows, so den is 0. Setting coef to 0 instead would put
        // the center on the chord midpoint and draw a half circle of radius 1 ending at (1, 0).
        expect(arcCenter(0, 0, 1, 1, 0, false, true, 1e-170, 0)).toBeNull();
        expect(arcCenter(0, 0, 1e-100, 1e-100, 0, true, true, 1e-170, 0)).toBeNull();
        // Subnormal den (end points 1e-155 apart): x / den overflows to Infinity, then Infinity · 0.
        expect(arcCenter(0, 0, 1, 1, 0, false, true, 1e-155, 0)).toBeNull();
        // Radii whose squares overflow.
        expect(arcCenter(0, 0, 1e200, 1e200, 0, false, true, 10, 0)).toBeNull();
        expect(
            toAbsolute([
                { cmd: 'M', args: [0, 0] },
                { cmd: 'A', args: [1, 1, 0, 1, 1, 1e-170, 0] },
            ]),
        ).toEqual([
            { cmd: 'M', args: [0, 0] },
            { cmd: 'C', args: [0, 0, 1e-170, 0, 1e-170, 0] },
        ]);
    });

    it('scales radii whose squares underflow without losing them', () => {
        // r = 1e-170 on a chord of 10: rx² underflows, √lambda (a hypot) does not.
        const arc = arcCenter(0, 0, 1e-170, 1e-170, 0, false, true, 10, 0)!;
        expect(arc.rx).toBeCloseTo(5, 12);
        expect([arc.cx, arc.cy]).toEqual([5, 0]);
        expect(arc.delta).toBeCloseTo(Math.PI, 15);
    });

    it('handles an exact and a near semicircle, with the sweep flag choosing the side', () => {
        const ccw = arcCenter(0, 0, 10, 10, 0, false, false, 20, 0)!;
        const cw = arcCenter(0, 0, 10, 10, 0, false, true, 20, 0)!;
        expect([ccw.cx, ccw.cy, cw.cx, cw.cy]).toEqual([10, 0, 10, 0]);
        expect(ccw.delta).toBeCloseTo(-Math.PI, 15);
        expect(cw.delta).toBeCloseTo(Math.PI, 15);
        // Chord e = 1e-9 short of the diameter: center d = √((e/2)(20 − e/2)) ≈ 1e-4 off the chord
        // (well conditioned form), small sweep π − 2·asin(d / r).
        const e = 1e-9;
        const near = arcCenter(0, 0, 10, 10, 0, false, true, 20 - e, 0)!;
        const d = Math.sqrt((e / 2) * (20 - e / 2));
        expect(Math.abs(near.cx - (20 - e) / 2)).toBeLessThan(1e-12);
        expect(Math.abs(Math.abs(near.cy) - d) / d).toBeLessThan(1e-5);
        expect(Math.abs(near.delta - (Math.PI - 2 * Math.asin(d / 10)))).toBeLessThan(1e-9);
    });

    it('resolves a tiny sweep accurately (atan2, where acos loses half its digits)', () => {
        // Chord 0.001 on a circle of radius 1000: delta = 2·asin(5e-7).
        const arc = arcCenter(0, 0, 1000, 1000, 0, false, true, 0.001, 0)!;
        const exact = 2 * Math.asin(5e-7);
        expect(Math.abs(arc.delta - exact) / exact).toBeLessThan(1e-9);
    });
});

describe('toAbsolute arc lowering', () => {
    it('lowers a lambda > 1 arc to cubics on the arcCenter ellipse', () => {
        const out = toAbsolute(parsePath('M0 0A1 0.02 30 0 1 20 5'));
        expect(out.map((c) => c.cmd)).toEqual(['M', 'C', 'C']);
        const arc = arcCenter(0, 0, 1, 0.02, 30, false, true, 20, 5)!;
        // Joint of the two quarter pieces: the ellipse point halfway through the sweep.
        const [jx, jy] = pointAt(arc, arc.theta + arc.delta / 2);
        expect(Math.hypot(out[1]!.args[4]! - jx, out[1]!.args[5]! - jy)).toBeLessThan(1e-12);
        expect(Math.hypot(out[2]!.args[4]! - 20, out[2]!.args[5]! - 5)).toBeLessThan(1e-12);
    });
});
