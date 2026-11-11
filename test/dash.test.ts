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
        expect(parseDasharray('1ex 2', 10)).toBeNull();
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

    it('draws pathLength="0" solid, whatever the pattern and offset (infinite scale, as browsers)', () => {
        // wpt path/distance/pathlength-path-zero: the closed square keeps its closing join.
        const square = 'M10 10L110 10L110 110L10 110Z';
        expect(dashPathData(square, [1, 1], 1, TOL, { pathLength: 0 })).toBe(square);
        expect(dashPathData('M0 0h10', [0, 3], 0, TOL, { pathLength: 0 })).toBe('M0 0L10 0');
    });

    it('ignores a negative or NaN pathLength (an error per SVG 2)', () => {
        const plain = dashPathData('M0 0h10', [4, 2], 0, TOL);
        expect(plain).toBe('M0 0L4 0M6 0L10 0');
        for (const pathLength of [-4, Number.NaN])
            expect(dashPathData('M0 0h10', [4, 2], 0, TOL, { pathLength })).toBe(plain);
    });

    it('returns null past MAX_DASHES (tiny dash on a huge path)', () => {
        expect(dashPathData(`M0 0h${MAX_DASHES * 10}`, [1, 1], 0, TOL)).toBeNull();
        expect(dashPathData(`M0 0h${MAX_DASHES}`, [1e-9, 1e-9], 0, TOL)).toBeNull();
    });
});

describe('dashPathData on elliptical arcs (measured on the true conic)', () => {
    /** Ends of each dash (sub-path): its first point and its last point. */
    const ends = (d: string): [Point, Point][] => subpaths(d).map((sp) => [sp[0]![0]!, sp.at(-1)!.at(-1)!]);
    const near = (p: Point, q: Point): number => Math.hypot(p[0] - q[0], p[1] - q[1]);
    const P = 6;

    it('cuts a dashed circle at exact angles, without a parasitic dash at the start (wpt pathlength-002)', () => {
        // r = 100: 2πr = 628.3185 < 16 × 39.27, so the last gap reaches the end: 8 dashes, each 45°.
        // Its cubic lowering is 0.09 longer, which used to shift every cut by 0.02–0.09 and start a
        // 0.09 dash before angle 0, merged into the first one.
        const d = dashPathData(
            ellipseDashPath('M20,240a100,100 0 1 0 200,0a100,100 0 1 0 -200,0z'),
            [39.27, 39.27],
            0,
            TOL,
            {
                precision: P,
            },
        )!;
        const dashes = ends(d);
        expect(dashes).toHaveLength(8);
        const at = (s: number): Point => [120 + 100 * Math.cos(s / 100), 240 + 100 * Math.sin(s / 100)];
        dashes.forEach(([a, b], k) => {
            expect(near(a, at(78.54 * k))).toBeLessThan(TOL);
            expect(near(b, at(78.54 * k + 39.27))).toBeLessThan(TOL);
        });
        // Every piece stays on the circle (cubics of ≤ 90°, 2.7e-4·r radial error at most).
        for (const sp of subpaths(d))
            for (const seg of sp)
                for (let t = 0; t <= 1; t += 0.125) {
                    const [x, y] = bezier(seg, t);
                    expect(Math.abs(Math.hypot(x - 120, y - 240) - 100)).toBeLessThan(0.03);
                }
    });

    it('measures a path’s own arcs the same way (relative, implicit repetition)', () => {
        const circle = ellipseDashPath('M20,240a100,100 0 1 0 200,0a100,100 0 1 0 -200,0z');
        const path = 'm 220,240 a 100,100 0 0 1 -200,0 100,100 0 0 1 200,0 z';
        const opts = { precision: P };
        expect(ends(dashPathData(path, [39.27, 39.27], 0, TOL, opts)!)).toEqual(
            ends(dashPathData(circle, [39.27, 39.27], 0, TOL, opts)!),
        );
    });

    it('cuts a rotated ellipse arc at the arc lengths of the true ellipse', () => {
        // Large arc of the ellipse rx = 40, ry = 15 rotated 30°, from angle −90° to 180° (sweep 1).
        const [rx, ry, phi] = [40, 15, Math.PI / 6];
        const at = (a: number): Point => [
            Math.cos(phi) * rx * Math.cos(a) - Math.sin(phi) * ry * Math.sin(a),
            Math.sin(phi) * rx * Math.cos(a) + Math.cos(phi) * ry * Math.sin(a),
        ];
        const [p0, p1] = [at(-Math.PI / 2), at(Math.PI)];
        const d = dashPathData(`M${p0[0]} ${p0[1]}A${rx} ${ry} 30 1 1 ${p1[0]} ${p1[1]}`, [7, 3], 0, TOL, {
            precision: P,
        })!;
        // Reference: points every 10 units of arc length, by dense sampling of the true ellipse.
        const expected: Point[] = [];
        let s = 0;
        let prev = p0;
        for (let k = 1, next = 0; k <= 200_000; k++) {
            const q = at(-Math.PI / 2 + (k / 200_000) * 1.5 * Math.PI);
            const step = near(prev, q);
            while (next <= s + step) {
                const f = (next - s) / step;
                expected.push([prev[0] + (q[0] - prev[0]) * f, prev[1] + (q[1] - prev[1]) * f]);
                next += 10;
            }
            s += step;
            prev = q;
        }
        const starts = ends(d).map(([a]) => a);
        expect(starts).toHaveLength(expected.length);
        starts.forEach((p, k) => expect(near(p, expected[k]!)).toBeLessThan(TOL));
    });

    it('treats a zero radius as a line and scales radii too small for the chord (SVG 2 out-of-range arcs)', () => {
        expect(dashPathData('M0 0A0 5 0 0 1 10 0', [4, 2], 0, TOL)).toBe('M0 0L4 0M6 0L10 0');
        // r = 1 on a chord of 20 becomes the semicircle of center (10, 0), radius 10 (length 10π):
        // dashes [0, 10], [11, 21], [22, 10π], at angle π + s/10.
        const at = (s: number): Point => [10 + 10 * Math.cos(Math.PI + s / 10), 10 * Math.sin(Math.PI + s / 10)];
        const dashes = ends(dashPathData('M0 0A1 1 0 0 1 20 0', [10, 1], 0, TOL, { precision: P })!);
        expect(dashes).toHaveLength(3);
        [0, 11, 22].forEach((s, k) => {
            expect(near(dashes[k]![0], at(s))).toBeLessThan(TOL);
            expect(near(dashes[k]![1], at(Math.min(s + 10, 10 * Math.PI)))).toBeLessThan(TOL);
        });
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

describe('dash budget (MAX_DASHES)', () => {
    // A [1, 1] pattern on a line of length 2n yields exactly n dashes.
    const atBudget = 2 * MAX_DASHES;
    const svg = (length: number, dasharray: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
        `<path d="M0 0h${length}" stroke="#000" fill="none" stroke-dasharray="${dasharray}"/></svg>`;
    const pathData = (xml: string): string => /android:pathData="([^"]*)"/.exec(xml)![1]!;
    const timed = <T>(fn: () => T): [T, number] => {
        const start = performance.now();
        const result = fn();
        return [result, performance.now() - start];
    };

    it('emits every dash when the pattern needs exactly MAX_DASHES, one more gives up', () => {
        expect(dashPathData(`M0 0h${atBudget}`, [1, 1], 0, TOL)!.match(/M/g)).toHaveLength(MAX_DASHES);
        expect(dashPathData(`M0 0h${atBudget + 2}`, [1, 1], 0, TOL)).toBeNull();
    });

    it('converts a pattern at the budget into dashes, without warning, in bounded time', () => {
        for (const optimize of [true, false]) {
            const [{ xml, warnings }, ms] = timed(() => convert(svg(atBudget, '1'), { optimize, strict: true }));
            expect(warnings).toEqual([]);
            expect(pathData(xml).match(/M/g)).toHaveLength(MAX_DASHES);
            expect(ms).toBeLessThan(1000);
        }
    });

    it('warns and falls back to the solid stroke past the budget, in bounded time', () => {
        // svgo must not round a single tiny value to "0" (= no dashes): the pattern reaches the dasher.
        for (const [dasharray, optimize] of [
            ['0.0001', false],
            ['0.0001', true],
            ['0.001', false],
            ['0.001', true],
            ['1', false],
        ] as const) {
            const length = dasharray === '1' ? atBudget + 2 : 20_000;
            const [{ xml, warnings }, ms] = timed(() => convert(svg(length, dasharray), { optimize }));
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-stroke-dasharray']);
            expect(warnings[0]!.message).toContain('drawn solid');
            expect(pathData(xml)).toBe(`M0 0h${length}`);
            expect(xml).toContain('android:strokeColor="#FF000000"');
            expect(ms).toBeLessThan(1000);
        }
    });

    it('rejects an over-budget pattern under strict, the warning being lossy', () => {
        for (const optimize of [true, false])
            for (const dasharray of ['0.001', '0.0001'])
                expect(() => convert(svg(20_000, dasharray), { optimize, strict: true })).toThrow(
                    /\[unsupported-stroke-dasharray\]/,
                );
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

describe('pathLength="0" through convert', () => {
    const svg = (el: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">${el}</svg>`;
    const pathData = (xml: string): string[] => [...xml.matchAll(/android:pathData="([^"]*)"/g)].map((m) => m[1]!);
    const dash =
        'pathLength="0" stroke-dasharray="1 1" stroke-dashoffset="1" fill="none" stroke="#000" stroke-width="10"';

    it('draws a <path> solid in both modes (wpt pathlength-path-zero)', () => {
        for (const optimize of [true, false]) {
            const { xml, warnings } = convert(svg(`<path d="M10,10L110,10L110,110L10,110Z" ${dash}/>`), {
                optimize,
                strict: true,
            });
            expect(warnings).toEqual([]);
            const [d] = pathData(xml);
            expect(d!.match(/M/gi)).toHaveLength(1);
            expect(d).toMatch(/z$/i);
        }
    });

    it('draws shapes solid (optimize: false)', () => {
        for (const el of [
            `<rect x="10" y="10" width="100" height="100" ${dash}/>`,
            `<circle cx="60" cy="60" r="50" ${dash}/>`,
            `<line x1="10" y1="10" x2="110" y2="10" ${dash}/>`,
        ]) {
            const { xml, warnings } = convert(svg(el), { optimize: false, strict: true });
            expect(warnings).toEqual([]);
            const [d] = pathData(xml);
            expect(d!.match(/M/gi)).toHaveLength(1);
        }
    });

    it('keeps negative pathLength ignored (wpt pathlength-path-negative)', () => {
        const neg = convert(svg(`<path d="M10,10L110,10L110,110L10,110Z" ${dash.replace('"0"', '"-4"')}/>`), {
            optimize: false,
        }).xml;
        expect(pathData(neg)[0]!.match(/M/g)!.length).toBeGreaterThan(100);
    });
});
