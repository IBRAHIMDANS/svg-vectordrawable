import { describe, expect, it } from 'vitest';
import { convert, ConversionError, WARNING_CODES } from '../src/index.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';
import { vdToSvg } from './visual/vdToSvg.js';

const svg = (body: string, attrs = 'viewBox="0 0 24 24"'): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

const PLAIN = svg('<path d="M0 0h24v24H0z" fill="#f00"/>');
const EVEN_ODD = svg('<path d="M0 0h24v24H0zM6 6h12v12H6z" fill-rule="evenodd"/>');
/** Overlapping squares: their evenodd region has no nonzero rewrite by orientation. */
const CROSSING = svg('<path d="M2 2h12v12H2zM8 8h12v12H8z" fill-rule="evenodd"/>');
const LINEAR = svg(
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
        '<path d="M0 0h24v24H0z" fill="url(#g)"/>',
);
const GRADIENT_STROKE = svg(
    '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="24"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
        '<path d="M2 12h20" fill="none" stroke="url(#g)" stroke-width="2"/>',
);
/** A single path whose pathData exceeds 800 characters (120 small squares). */
const LONG_PATH = svg(`<path d="${Array.from({ length: 120 }, (_, i) => `M${i % 24} ${i % 20}h1v1h-1z`).join('')}"/>`);
const codes = (r: { warnings: { code: string }[] }): string[] => r.warnings.map((w) => w.code);

describe('result.minSdk', () => {
    for (const optimize of [true, false]) {
        describe(`optimize: ${optimize}`, () => {
            it('is 21 for a plain solid-color vector', () => {
                expect(convert(PLAIN, { optimize }).minSdk).toBe(21);
            });

            it('is 24 when the output uses android:fillType', () => {
                const r = convert(EVEN_ODD, { optimize });
                expect(r.xml).toContain('android:fillType="evenOdd"');
                expect(r.minSdk).toBe(24);
            });

            it('is 24 for a gradient fill', () => {
                const r = convert(LINEAR, { optimize });
                expect(r.xml).toContain('<aapt:attr');
                expect(r.minSdk).toBe(24);
            });

            it('is 24 for a gradient stroke', () => {
                const r = convert(GRADIENT_STROKE, { optimize });
                expect(r.xml).toContain('android:strokeColor');
                expect(r.minSdk).toBe(24);
            });
        });
    }

    it('follows the output, not the input: an unused gradient or a clip-rule keeps 21', () => {
        const unused = svg(
            '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
                '<path d="M0 0h24v24H0z" fill="#f00"/>',
        );
        expect(convert(unused, { optimize: false }).minSdk).toBe(21);
        // evenodd clip-rule is rewritten to nonzero geometry: no android:fillType in the output.
        const clip = svg(
            '<clipPath id="c" clip-rule="evenodd"><path d="M0 0h24v24H0zM6 6h12v12H6z"/></clipPath>' +
                '<path d="M0 0h24v24H0z" clip-path="url(#c)"/>',
        );
        const r = convert(clip, { optimize: false });
        expect(r.xml).not.toContain('fillType');
        expect(r.minSdk).toBe(21);
    });
});

describe('minSdk option (min-sdk-exceeded)', () => {
    it('is a known warning code', () => {
        expect(WARNING_CODES).toContain('min-sdk-exceeded');
    });

    it('does not check anything when unset', () => {
        expect(codes(convert(LINEAR))).toEqual([]);
    });

    it('warns, naming the feature, when the output needs more than minSdk', () => {
        const r = convert(LINEAR, { minSdk: 21 });
        expect(r.warnings).toHaveLength(1);
        expect(r.warnings[0]!.code).toBe('min-sdk-exceeded');
        expect(r.warnings[0]!.message).toMatch(/API 24 \(minSdk 21\)/);
        expect(r.warnings[0]!.message).toMatch(/gradient/);
        expect(r.warnings[0]!.message).not.toMatch(/fillType/);
    });

    it('names every feature responsible', () => {
        const both = svg(
            '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
                '<path d="M2 2h12v12H2zM8 8h12v12H8z" fill="url(#g)" fill-rule="evenodd"/>',
        );
        const [w] = convert(both, { minSdk: 23 }).warnings;
        expect(w!.message).toMatch(/gradient/);
        expect(w!.message).toMatch(/android:fillType/);
    });

    it('stays silent when minSdk is high enough, or the output needs only API 21', () => {
        expect(codes(convert(LINEAR, { minSdk: 24 }))).toEqual([]);
        expect(codes(convert(EVEN_ODD, { minSdk: 26 }))).toEqual([]);
        expect(codes(convert(PLAIN, { minSdk: 21 }))).toEqual([]);
    });

    it('is not escalated by strict, but rules can make it an error', () => {
        expect(codes(convert(CROSSING, { minSdk: 21, strict: true }))).toEqual(['min-sdk-exceeded']);
        expect(() => convert(CROSSING, { minSdk: 21, rules: { 'min-sdk-exceeded': 'error' } })).toThrow(
            ConversionError,
        );
        expect(codes(convert(CROSSING, { minSdk: 21, rules: { 'min-sdk-exceeded': 'off' } }))).toEqual([]);
    });

    it('rejects an invalid minSdk', () => {
        expect(() => convert(PLAIN, { minSdk: 0 })).toThrow(TypeError);
        expect(() => convert(PLAIN, { minSdk: 21.5 })).toThrow(TypeError);
        expect(() => convert(PLAIN, { minSdk: Number.NaN })).toThrow(TypeError);
    });
});

describe('evenodd fills below API 24', () => {
    const RING = svg('<path d="M2 2h20v20H2zM7 7h10v10H7z" fill="#f00" fill-rule="evenodd"/>');
    const TARGET = svg(
        '<path d="M12 1a11 11 0 1 0 0.001 0zM12 4a8 8 0 1 0 0.001 0zM12 7a5 5 0 1 0 0.001 0zM12 10a2 2 0 1 0 0.001 0z" fill="#00f" fill-rule="evenodd"/>',
    );
    const STROKED_RING = svg(
        '<path d="M2 2h20v20H2zM7 7h10v10H7z" fill="#f00" fill-rule="evenodd" stroke="#000" stroke-width="1.5"/>',
    );

    /** Converts at minSdk 21: no fillType, no warning, API 21, rendered like the source. */
    function expectNonZero(source: string, optimize: boolean): string {
        const r = convert(source, { minSdk: 21, optimize });
        expect(r.xml).not.toContain('fillType');
        expect(codes(r)).toEqual([]);
        expect(r.minSdk).toBe(21);
        const result = compareSvgs(source, vdToSvg(r.xml));
        expect(result.inked).toBeGreaterThan(0);
        expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        return r.xml;
    }

    for (const optimize of [true, false]) {
        describe(`optimize: ${optimize}`, () => {
            it('rewrites a ring, a 4-level target and a stroked ring as nonzero geometry', () => {
                for (const source of [RING, TARGET, STROKED_RING]) {
                    // The rule matters: the same path drawn nonzero as written would differ.
                    const asIs = convert(source, { optimize }).xml.replace(/\s*android:fillType="evenOdd"/, '');
                    expect(compareSvgs(source, vdToSvg(asIs)).mismatch).toBeGreaterThan(0.05);
                    expectNonZero(source, optimize);
                }
            });

            it('keeps fillType and warns for crossing contours', () => {
                const r = convert(CROSSING, { minSdk: 21, optimize });
                expect(r.xml).toContain('android:fillType="evenOdd"');
                expect(codes(r)).toEqual(['min-sdk-exceeded']);
                expect(r.minSdk).toBe(24);
            });

            it('keeps fillType when the stroke on the same path has an open subpath', () => {
                const open = svg('<path d="M2 2h20v20H2M7 7h10v10H7" fill-rule="evenodd" stroke="#000"/>');
                const r = convert(open, { minSdk: 21, optimize });
                expect(r.xml).toContain('android:fillType="evenOdd"');
                expect(codes(r)).toEqual(['min-sdk-exceeded']);
            });

            it('rewrites the fill of a dashed stroke, which keeps its own path', () => {
                const dashed = svg(
                    '<path d="M2 2h20v20H2zM7 7h10v10H7z" fill="#f00" fill-rule="evenodd" stroke="#000" stroke-dasharray="3 2"/>',
                );
                expectNonZero(dashed, optimize);
            });

            it('drops the fillType of a path without a painted fill', () => {
                const strokeOnly = svg(
                    '<path d="M2 2h12v12H2zM8 8h12v12H8z" fill="none" fill-rule="evenodd" stroke="#000"/>',
                );
                const r = convert(strokeOnly, { minSdk: 21, optimize });
                expect(r.xml).not.toContain('fillType');
                expect(r.minSdk).toBe(21);
            });
        });
    }

    it('keeps the floatPrecision of the source path', () => {
        const ring = svg('<path d="M2.123456 2h20v20H2.123456zM7 7h10v10H7z" fill-rule="evenodd"/>');
        expect(convert(ring, { minSdk: 21, floatPrecision: 5, optimize: false }).xml).toContain('M2.12346 2');
        expect(convert(ring, { minSdk: 21, floatPrecision: 1, optimize: false }).xml).toContain('M2.1 2');
    });

    it('changes nothing without minSdk, or with minSdk 24 and above', () => {
        for (const source of [RING, TARGET, STROKED_RING, CROSSING]) {
            const xml = convert(source).xml;
            expect(xml).toContain('android:fillType="evenOdd"');
            expect(convert(source, { minSdk: 24 }).xml).toBe(xml);
        }
    });

    it('still needs API 24 when a gradient remains', () => {
        const ring = svg(
            '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
                '<path d="M2 2h20v20H2zM7 7h10v10H7z" fill="url(#g)" fill-rule="evenodd"/>',
        );
        const r = convert(ring, { minSdk: 21 });
        expect(r.xml).not.toContain('fillType');
        expect(r.minSdk).toBe(24);
        expect(r.warnings[0]!.message).not.toMatch(/fillType/);
    });
});

describe('long-path-data (lint VectorPath)', () => {
    it('is off by default', () => {
        const r = convert(LONG_PATH, { optimize: false });
        expect(r.xml.match(/android:pathData="([^"]*)"/)![1]!.length).toBeGreaterThan(800);
        expect(codes(r)).toEqual([]);
    });

    it('reports pathData over 800 characters once enabled, with the longest length', () => {
        const r = convert(LONG_PATH, { optimize: false, rules: { 'long-path-data': 'warn' } });
        const length = r.xml.match(/android:pathData="([^"]*)"/)![1]!.length;
        expect(codes(r)).toEqual(['long-path-data']);
        expect(r.warnings[0]!.message).toContain(`1 pathData longer than 800 characters (longest: ${length})`);
    });

    it('does not fire on short paths', () => {
        expect(codes(convert(PLAIN, { rules: { 'long-path-data': 'warn' } }))).toEqual([]);
    });

    it('is not turned on by strict', () => {
        expect(codes(convert(LONG_PATH, { optimize: false, strict: true }))).toEqual([]);
    });
});

describe('large-vector (> 200dp)', () => {
    it('warns by default when width or height exceeds 200dp', () => {
        const wide = convert(svg('<path d="M0 0h10v10H0z"/>', 'width="201" height="24" viewBox="0 0 10 10"'));
        expect(codes(wide)).toEqual(['large-vector']);
        expect(wide.warnings[0]!.message).toContain('201×24dp');
        const tall = convert(svg('<path d="M0 0h10v10H0z"/>', 'viewBox="0 0 24 512"'));
        expect(codes(tall)).toEqual(['large-vector']);
    });

    it('accepts exactly 200dp', () => {
        expect(codes(convert(svg('<path d="M0 0h10v10H0z"/>', 'viewBox="0 0 200 200"')))).toEqual([]);
    });

    it('is not escalated by strict, and rules can silence or escalate it', () => {
        const big = svg('<path d="M0 0h10v10H0z"/>', 'viewBox="0 0 512 512"');
        expect(codes(convert(big, { strict: true }))).toEqual(['large-vector']);
        expect(codes(convert(big, { rules: { 'large-vector': 'off' } }))).toEqual([]);
        expect(() => convert(big, { rules: { 'large-vector': 'error' } })).toThrow(ConversionError);
    });
});
