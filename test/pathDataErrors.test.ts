import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { validPathData } from '../src/pathData.js';

/** SVG 2 §9.5.4: path data in error is rendered up to its last valid segment. */
describe('validPathData', () => {
    it.each([
        'M10 10 L20 20',
        'M0 0 h10 v10 z',
        '  M0,0 L10,10  ',
        'm0 0 10 10 20 0z',
        'M1e2 1e-1 L.5.5',
        'M0 0 a10 10 0 0120 0',
        'M0 0 a10 10 0 0 1 20 0',
        'M0 0 L+5-5 10.5e+1 3',
        'M0 0 z',
        'M0 0 L1 1 Z L2 2',
        'M0 0\tL1\n1\rL2\f2',
    ])('returns valid path data unchanged: %j', (d) => {
        expect(validPathData(d)).toBe(d);
    });

    it.each([
        // T-178: a number a float cannot hold is an error, like Firefox and Chrome draw it.
        ['M0 0L10 0L10 10L1e39 5Z', 'M0 0L10 0L10 10'],
        ['M0 0 L10 10 L-1e400 5', 'M0 0 L10 10'],
        ['M10 10 L20 20 L', 'M10 10 L20 20'],
        ['M10 10 L20 20 garbage', 'M10 10 L20 20'],
        ['M10,10 L20,20 L30', 'M10,10 L20,20'],
        ['M10 10 L20 20 30', 'M10 10 L20 20'],
        ['M0 0 L10 10 # 30 30', 'M0 0 L10 10'],
        ['M0 0 L10 10 Z M', 'M0 0 L10 10 Z'],
        ['M0 0 L5 5 Z 10 10', 'M0 0 L5 5 Z'],
        ['M0 0 L10 10,', 'M0 0 L10 10'],
        ['M0 0 L10 10, L5 5', 'M0 0 L10 10'],
        ['M0 0 L10 10,,5 5', 'M0 0 L10 10'],
        ['M0 0L10 10e', 'M0 0L10 10'],
        ['M0 0 L1 1 a10 10 0 2 1 20 0', 'M0 0 L1 1'],
        ['M0 0 L1 1 C1 2 3', 'M0 0 L1 1'],
        ['M0 0 L1 1 X2 2', 'M0 0 L1 1'],
    ])('cuts %j after its last valid segment', (d, expected) => {
        expect(validPathData(d)).toBe(expected);
    });

    it.each([
        '',
        ' ',
        '\n\t',
        'garbage',
        'M10 10 L',
        'M 10',
        'M10 10',
        'M0 0 M10 10',
        'L10 10 20 20',
        'z',
        '10 10',
        'M,0 0 L1 1',
        'M10 10 L20 L30 30',
        'M0 0 a10 10 0 2 1 20 0',
    ])('returns null when nothing drawable remains: %j', (d) => {
        expect(validPathData(d)).toBeNull();
    });
});

const svg = (d: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d}"/><rect width="1" height="1"/></svg>`;
const pathData = (xml: string): string[] => [...xml.matchAll(/android:pathData="([^"]*)"/g)].map((m) => m[1]!);
const codes = (r: { warnings: { code: string }[] }): string[] => r.warnings.map((w) => w.code);

describe('convert: path data in error', () => {
    describe.each([false, true])('optimize: %s', (optimize) => {
        it.each([
            ['missing command argument', 'M10 10 L20 20 L', 'M10 10 L20 20'],
            ['garbage after valid segments', 'M10 10 L20 20 garbage', 'M10 10 L20 20'],
            ['missing number at the end', 'M10,10 L20,20 L30', 'M10,10 L20,20'],
        ])('draws the valid prefix (%s)', (_, d, prefix) => {
            const r = convert(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="${d}"/></svg>`, {
                optimize,
            });
            // The segment 10,10 → 20,20 only, as each mode spells it (svgo rewrites it relative).
            expect(pathData(r.xml)).toEqual([optimize ? 'm10 10 10 10' : prefix]);
            expect(codes(r)).toEqual([]);
        });

        it.each([
            ['empty', ''],
            ['whitespace only', ' '],
            ['garbage', 'garbage'],
            ['command without argument', 'M10 10 L'],
            ['number missing mid-path', 'M10 10 L20 L30 30'],
            ['no leading moveto', 'L10 10 20 20'],
            ['moveto only', 'M10 10'],
            ['invalid arc flag', 'M0 0 a10 10 0 2 1 20 0'],
        ])('drops a path with nothing drawable (%s)', (_, d) => {
            const r = convert(svg(d), { optimize });
            // Only the rect is left.
            expect(pathData(r.xml)).toHaveLength(1);
            expect(pathData(r.xml)[0]).toMatch(/^M0[ ,]0h1v1/);
            expect(codes(r)).toEqual(['empty-path']);
        });

        it('strict rejects a path with nothing drawable', () => {
            for (const d of [' ', 'garbage', 'M10 10 L', 'M10 10']) {
                expect(() => convert(svg(d), { optimize, strict: true }), d).toThrow(/no drawable geometry/);
            }
        });

        it('keeps the next shape after a path cut after a closepath (no merge)', () => {
            const r = convert(svg('M0 0 L5 5 Z 10 10'), { optimize });
            expect(pathData(r.xml)).toHaveLength(2);
            expect(pathData(r.xml)[1]).toMatch(/^M0[ ,]0h1v1/);
            expect(codes(r)).toEqual([]);
        });

        it('keeps a valid path unchanged', () => {
            const r = convert(svg('M0 0 h10 v10 z'), { optimize });
            expect(pathData(r.xml)[0]).toBe(optimize ? 'M0 0h10v10z' : 'M0 0 h10 v10 z');
            expect(codes(r)).toEqual([]);
        });
    });

    it('cuts numbers after a closepath (parsePath would loop forever on them)', () => {
        const r = convert(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0 L5 5 Z 10 10"/></svg>',
            { optimize: false },
        );
        expect(pathData(r.xml)).toEqual(['M0 0 L5 5 Z']);
    });

    it('cuts a clip-path child in error too', () => {
        const r = convert(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><clipPath id="c"><path d="M0 0 H10 V10 Z L"/></clipPath>' +
                '<rect width="20" height="20" clip-path="url(#c)"/></svg>',
            { optimize: false },
        );
        expect(r.xml).toMatch(/<clip-path android:pathData="M0 0 H10 V10 Z"/);
    });
});
