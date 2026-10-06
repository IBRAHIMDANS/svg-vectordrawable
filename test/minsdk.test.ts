import { describe, expect, it } from 'vitest';
import { convert, ConversionError, WARNING_CODES } from '../src/index.js';

const svg = (body: string, attrs = 'viewBox="0 0 24 24"'): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

const PLAIN = svg('<path d="M0 0h24v24H0z" fill="#f00"/>');
const EVEN_ODD = svg('<path d="M0 0h24v24H0zM6 6h12v12H6z" fill-rule="evenodd"/>');
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
                '<path d="M0 0h24v24H0zM6 6h12v12H6z" fill="url(#g)" fill-rule="evenodd"/>',
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
        expect(codes(convert(EVEN_ODD, { minSdk: 21, strict: true }))).toEqual(['min-sdk-exceeded']);
        expect(() => convert(EVEN_ODD, { minSdk: 21, rules: { 'min-sdk-exceeded': 'error' } })).toThrow(
            ConversionError,
        );
        expect(codes(convert(EVEN_ODD, { minSdk: 21, rules: { 'min-sdk-exceeded': 'off' } }))).toEqual([]);
    });

    it('rejects an invalid minSdk', () => {
        expect(() => convert(PLAIN, { minSdk: 0 })).toThrow(TypeError);
        expect(() => convert(PLAIN, { minSdk: 21.5 })).toThrow(TypeError);
        expect(() => convert(PLAIN, { minSdk: Number.NaN })).toThrow(TypeError);
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
