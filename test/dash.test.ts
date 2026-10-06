import { describe, expect, it } from 'vitest';
import { dashPathData, ellipseDashPath, MAX_DASHES, parseDasharray } from '../src/dash.js';
import { convert } from '../src/index.js';

type Point = [number, number];

/** Sub-paths of an absolute M/L/Q/C/Z path: each a list of segments (start point + controls + end). */
function subpaths(d: string): Point[][][] {
    const tokens = d.match(/[MLQCZ]|-?\d*\.?\d+/g) ?? [];
    const out: Point[][][] = [];
    let pen: Point = [0, 0];
    let start: Point = [0, 0];
    let i = 0;
    const pt = (): Point => [Number(tokens[i++]), Number(tokens[i++])];
    while (i < tokens.length) {
        const cmd = tokens[i++]!;
        if (cmd === 'M') {
            pen = start = pt();
            out.push([]);
        } else if (cmd === 'Z') {
            out.at(-1)!.push([pen, start]);
            pen = start;
        } else {
            const n = cmd === 'L' ? 1 : cmd === 'Q' ? 2 : 3;
            const seg: Point[] = [pen];
            for (let k = 0; k < n; k++) seg.push(pt());
            out.at(-1)!.push(seg);
            pen = seg.at(-1)!;
        }
    }
    return out;
}

/** Bézier point by De Casteljau (any degree). */
function bezier(pts: Point[], t: number): Point {
    let level = pts;
    while (level.length > 1)
        level = level
            .slice(1)
            .map((q, k) => [level[k]![0] + (q[0] - level[k]![0]) * t, level[k]![1] + (q[1] - level[k]![1]) * t]);
    return level[0]!;
}

/** Length of a segment by dense sampling (reference measure, independent of src/dash.ts). */
function segLength(seg: Point[]): number {
    const n = seg.length === 2 ? 1 : 2000;
    let len = 0;
    let prev = seg[0]!;
    for (let k = 1; k <= n; k++) {
        const p = bezier(seg, k / n);
        len += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
        prev = p;
    }
    return len;
}

/** Lengths of the dashes (sub-paths) of a dashed pathData. */
const dashLengths = (d: string): number[] => subpaths(d).map((sp) => sp.reduce((s, seg) => s + segLength(seg), 0));

const TOL = 1e-3;

describe('parseDasharray', () => {
    it('repeats an odd list and resolves units and percentages', () => {
        expect(parseDasharray('3', 10)).toEqual([3, 3]);
        expect(parseDasharray('1, 2 3', 10)).toEqual([1, 2, 3, 1, 2, 3]);
        expect(parseDasharray('1in 10%', 50)).toEqual([96, 5]);
    });

    it('is solid ([]) for none, all zeros, a negative value or no gap', () => {
        expect(parseDasharray(undefined, 10)).toEqual([]);
        expect(parseDasharray('none', 10)).toEqual([]);
        expect(parseDasharray('0 0', 10)).toEqual([]);
        expect(parseDasharray('4 -2', 10)).toEqual([]);
        expect(parseDasharray('4 0', 10)).toEqual([]);
    });

    it('is null (not resolvable) for font-relative units', () => {
        expect(parseDasharray('1em 2', 10)).toBeNull();
    });
});

describe('dashPathData', () => {
    it('cuts a line exactly with "4 2"', () => {
        expect(dashPathData('M0 0h10', [4, 2], 0, TOL)).toBe('M0 0L4 0M6 0L10 0');
    });

    it('repeats an odd pattern ("3" = "3 3")', () => {
        expect(dashPathData('M0 0h10', parseDasharray('3', 10)!, 0, TOL)).toBe('M0 0L3 0M6 0L9 0');
    });

    it('shifts the pattern by a positive offset', () => {
        // Offset 1 into "4 2": the first dash has 3 left.
        expect(dashPathData('M0 0h10', [4, 2], 1, TOL)).toBe('M0 0L3 0M5 0L9 0');
    });

    it('shifts the pattern by a negative offset (starts inside the previous period)', () => {
        // Offset −1 ≡ 5 in a period of 6: one unit of gap, then dashes at 1–5 and 7–10.
        expect(dashPathData('M0 0h10', [4, 2], -1, TOL)).toBe('M1 0L5 0M7 0L10 0');
    });

    it('restarts the pattern at each subpath', () => {
        expect(dashPathData('M0 0h5M0 2h5', [4, 2], 0, TOL)).toBe('M0 0L4 0M0 2L4 2');
    });

    it('includes the closing segment of a closed path and joins the dash over the start corner', () => {
        // Square of perimeter 40, "6 4" from offset 2: dashes [0,4] [8,14] [18,24] [28,34] [38,40].
        // [28,34] lies on the closing segment; [38,40] continues into [0,4] across the start corner.
        const d = dashPathData('M0 0h10v10h-10z', [6, 4], 2, TOL)!;
        expect(d).toBe('M8 0L10 0L10 4M10 8L10 10L6 10M2 10L0 10L0 6M0 2L0 0L4 0');
        expect(subpaths(d)).toHaveLength(4);
    });

    it('keeps a dash covering the whole closed subpath closed (corner joined)', () => {
        expect(dashPathData('M0 0h10v10h-10z', [50, 10], 0, TOL)).toBe('M0 0L10 0L10 10L0 10L0 0Z');
    });

    it('emits zero-length dashes as zero-length segments (dots with round caps)', () => {
        expect(dashPathData('M0 0h10', [0, 5], 0, TOL)).toBe('M0 0L0 0M5 0L5 0');
        // Dots along a closed path: at 0, 15 and 30 (the bottom-left corner); none at 40 (= the end).
        expect(dashPathData('M0 0h10v10h-10z', [0, 15], 0, TOL)).toBe('M0 0L0 0M10 5L10 5M0 10L0 10');
    });

    it('splits curves into Bézier pieces whose lengths match the pattern within tolerance', () => {
        // Semicircle of radius 20 (arc lowered to cubics): length ≈ 62.83.
        const d = dashPathData('M0 0A20 20 0 0 1 40 0', [5, 3], 0, TOL, { precision: 6 })!;
        expect(d).not.toMatch(/L/); // curve pieces, not polylines
        const lengths = dashLengths(d);
        // Length 20π ≈ 62.83 = 7 periods of 8 + a full dash of 5 + a partial gap.
        expect(lengths).toHaveLength(8);
        for (const len of lengths) expect(Math.abs(len - 5)).toBeLessThan(TOL);
    });

    it('splits quadratic curves into quadratic pieces', () => {
        const d = dashPathData('M0 0Q10 10 20 0', [3, 1], 0, TOL, { precision: 6 })!;
        expect(d).toMatch(/^M0 0Q/);
        for (const len of dashLengths(d).slice(0, -1)) expect(len).toBeCloseTo(3, 2);
    });

    it('scales the pattern by actual length / pathLength', () => {
        // pathLength 1 on a length-10 line: "0.4 0.2" means "4 2".
        expect(dashPathData('M0 0h10', [0.4, 0.2], 0, TOL, { pathLength: 1 })).toBe('M0 0L4 0M6 0L10 0');
    });

    it('returns null past MAX_DASHES (tiny dash on a huge path)', () => {
        expect(dashPathData(`M0 0h${MAX_DASHES * 10}`, [1, 1], 0, TOL)).toBeNull();
        expect(dashPathData(`M0 0h${MAX_DASHES}`, [1e-9, 1e-9], 0, TOL)).toBeNull();
    });
});

describe('ellipseDashPath', () => {
    it('restarts a shapes.ts circle at 3 o’clock, turning clockwise (SVG 2 dash origin)', () => {
        expect(ellipseDashPath('M2,5a3,3 0 1 0 6,0a3,3 0 1 0 -6,0z')).toBe(
            'M8,5A3,3 0 0 1 5,8A3,3 0 0 1 2,5A3,3 0 0 1 5,2A3,3 0 0 1 8,5Z',
        );
    });

    it('leaves any other path unchanged', () => {
        expect(ellipseDashPath('M0 0h10')).toBe('M0 0h10');
    });
});

describe('dash properties inheritance', () => {
    const svg = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;
    const pathData = (xml: string): string => /android:pathData="([^"]*)"/.exec(xml)![1]!;

    it('inherits stroke-dashoffset from a parent <g> like stroke-dasharray (SVG inherits both)', () => {
        const own = convert(
            svg('<path d="M0 0h20" stroke="#000" fill="none" stroke-dasharray="4 2" stroke-dashoffset="1"/>'),
            {
                optimize: false,
            },
        ).xml;
        const inherited = convert(
            svg('<g stroke-dasharray="4 2" stroke-dashoffset="1"><path d="M0 0h20" stroke="#000" fill="none"/></g>'),
            { optimize: false },
        ).xml;
        expect(pathData(inherited)).toBe(pathData(own));
        expect(pathData(own)).toMatch(/^M0 0L3 0/); // the first dash is shortened by the offset
    });
});
