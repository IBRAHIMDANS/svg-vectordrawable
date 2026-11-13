import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { toAbsolute } from '../src/pathAbsolute.js';
import { transformPathData, validPathData } from '../src/pathData.js';
import { parsePath } from '../src/pathParse.js';
import {
    applyPoint,
    decompose,
    formatMatrix,
    IDENTITY,
    type Matrix,
    maxStretch,
    multiply,
    parseTransform,
} from '../src/transform.js';
import { path, write } from './pathArbitraries.js';
import { propertyParams, propertyTimeout } from './property.js';

/** Property-based tests of matrices and path transforms (T-177, step 2). */

/** A coefficient in a range where products keep about 12 significant digits. */
const coefficient = fc.double({ min: -4, max: 4, noNaN: true });
const offset = fc.double({ min: -1000, max: 1000, noNaN: true });
const matrix: fc.Arbitrary<Matrix> = fc.record({
    a: coefficient,
    b: coefficient,
    c: coefficient,
    d: coefficient,
    e: offset,
    f: offset,
});
const point = fc.tuple(offset, offset);

/** Absolute tolerance for values of magnitude `scale` after a few float operations. */
const tolerance = (scale: number): number => 1e-9 * Math.max(1, scale);

/** The numbers of an absolute path written by `transformPathData`, with its command letters. */
function numbersOf(d: string): { letters: string; values: number[] } {
    return {
        letters: d.replace(/[^A-Za-z]/g, ''),
        values: [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0])),
    };
}

describe('multiply / applyPoint (property)', { timeout: propertyTimeout }, () => {
    it('applying multiply(A, B) is applying B then A', () => {
        fc.assert(
            fc.property(matrix, matrix, point, (a, b, [x, y]) => {
                const [px, py] = applyPoint(multiply(a, b), x, y);
                const [qx, qy] = applyPoint(a, ...applyPoint(b, x, y));
                const scale = (Math.abs(qx) + Math.abs(qy) + 1) * 64;
                expect(Math.abs(px - qx)).toBeLessThanOrEqual(tolerance(scale));
                expect(Math.abs(py - qy)).toBeLessThanOrEqual(tolerance(scale));
            }),
            propertyParams,
        );
    });

    it('the identity is neutral on both sides', () => {
        fc.assert(
            fc.property(matrix, (m) => {
                // 0 + -0 is 0: compare as numbers, not with Object.is.
                for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
                    expect(multiply(IDENTITY, m)[k] === m[k]).toBe(true);
                    expect(multiply(m, IDENTITY)[k] === m[k]).toBe(true);
                }
            }),
            propertyParams,
        );
    });
});

describe('parseTransform (property)', { timeout: propertyTimeout }, () => {
    it('reads back formatMatrix exactly', () => {
        fc.assert(
            fc.property(matrix, (m) => {
                const parsed = parseTransform(formatMatrix(m));
                // -0 written as "0" reads back as 0: compare as numbers.
                for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) expect(parsed![k] === m[k]).toBe(true);
            }),
            propertyParams,
        );
    });

    it('a transform list is the product of its functions, left to right', () => {
        fc.assert(
            fc.property(matrix, matrix, (a, b) => {
                const parsed = parseTransform(`${formatMatrix(a)} ${formatMatrix(b)}`)!;
                const product = multiply(a, b);
                for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
                    expect(Math.abs(parsed[k] - product[k])).toBeLessThanOrEqual(tolerance(Math.abs(product[k])));
                }
            }),
            propertyParams,
        );
    });
});

describe('decompose (property)', { timeout: propertyTimeout }, () => {
    /** The matrix of an Android `<group>`: scale, then rotate, then translate. */
    function recompose(g: ReturnType<typeof decompose>): Matrix {
        const r = (g.rotation * Math.PI) / 180;
        const [cos, sin] = [Math.cos(r), Math.sin(r)];
        return {
            a: cos * g.scaleX,
            b: sin * g.scaleX,
            c: -sin * g.scaleY,
            d: cos * g.scaleY,
            e: g.translateX,
            f: g.translateY,
        };
    }

    const nonZero = fc.oneof(
        fc.double({ min: 0.01, max: 100, noNaN: true }),
        fc.double({ min: -100, max: -0.01, noNaN: true }),
    );

    it('a translate · rotate · scale matrix decomposes without skew and recomposes to itself', () => {
        fc.assert(
            fc.property(
                offset,
                offset,
                fc.double({ min: -720, max: 720, noNaN: true }),
                nonZero,
                nonZero,
                (tx, ty, deg, sx, sy) => {
                    const m = parseTransform(`translate(${tx} ${ty}) rotate(${deg}) scale(${sx} ${sy})`)!;
                    const g = decompose(m);
                    expect(g.hasSkew).toBe(false);
                    const back = recompose(g);
                    for (const k of ['a', 'b', 'c', 'd', 'e', 'f'] as const) {
                        expect(Math.abs(back[k] - m[k])).toBeLessThanOrEqual(tolerance(100 + Math.abs(m[k])));
                    }
                },
            ),
            propertyParams,
        );
    });

    it('whenever no skew is reported, the group draws the matrix (within the skew threshold)', () => {
        fc.assert(
            fc.property(matrix, (m) => {
                const g = decompose(m);
                fc.pre(!g.hasSkew && g.scaleX > 1e-3);
                const back = recompose(g);
                const bound = 2e-4 * maxStretch(m) + 1e-9;
                for (const k of ['a', 'b', 'c', 'd'] as const)
                    expect(Math.abs(back[k] - m[k])).toBeLessThanOrEqual(bound);
                expect(back.e).toBe(m.e);
                expect(back.f).toBe(m.f);
            }),
            propertyParams,
        );
    });
});

describe('transformPathData (property)', { timeout: propertyTimeout }, () => {
    // Coordinates within ±1000 (0 or at least 1e-3) and coefficients within ±4: results stay far from fmt's limits.
    const smallPath = path({ max: 1000, min: 1e-3, firstMove: true });

    it('maps every coordinate of the absolute path through the matrix, rounded to 3 decimals', () => {
        fc.assert(
            fc.property(smallPath, matrix, ([commands, s], m) => {
                const d = write(commands, s);
                const out = numbersOf(transformPathData(d, m));
                const expected = toAbsolute(parsePath(d)).flatMap(({ args }) => {
                    const mapped: number[] = [];
                    for (let k = 0; k + 1 < args.length; k += 2) mapped.push(...applyPoint(m, args[k]!, args[k + 1]!));
                    return mapped;
                });
                expect(out.values).toHaveLength(expected.length);
                out.values.forEach((v, i) => {
                    expect(Math.abs(v - expected[i]!)).toBeLessThanOrEqual(
                        0.0005 + tolerance(Math.abs(expected[i]!) * 1e3),
                    );
                });
            }),
            propertyParams,
        );
    });

    it('transforming by B then by A is transforming by multiply(A, B), up to rounding', () => {
        fc.assert(
            fc.property(smallPath, matrix, matrix, ([commands, s], a, b) => {
                const d = write(commands, s);
                const twice = numbersOf(transformPathData(transformPathData(d, b), a));
                const once = numbersOf(transformPathData(d, multiply(a, b)));
                expect(twice.letters).toBe(once.letters);
                // Each result is rounded once at the end (half a thousandth each); the intermediate rounding
                // (up to 0.0005·√2 as a vector) is then stretched by A.
                const bound = 0.001 + 0.0005 * Math.SQRT2 * maxStretch(a) + 1e-9;
                twice.values.forEach((v, i) => {
                    expect(Math.abs(v - once.values[i]!)).toBeLessThanOrEqual(bound + tolerance(Math.abs(v) * 1e3));
                });
            }),
            propertyParams,
        );
    });

    it('writes path data that is valid as a whole', () => {
        fc.assert(
            fc.property(smallPath, matrix, ([commands, s], m) => {
                const out = transformPathData(write(commands, s), m);
                const valid = validPathData(out);
                expect(valid === out || valid === null).toBe(true);
            }),
            propertyParams,
        );
    });
});
