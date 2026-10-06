import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, vectorDrawableToSvg } from '../src/index.js';
import * as browser from '../src/browser.js';
import { vdToSvg } from './visual/vdToSvg.js';
import { compareSvgs, renderSvg, DEFAULT_MAX_MISMATCH } from './visual/compare.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const fixture = (file: string) => readFileSync(join(here, 'fixtures', file), 'utf8');

/** A 24×24 VectorDrawable whose `<vector>` carries `attrs` and contains `body`. */
function vd(body: string, attrs = ''): string {
    return (
        '<vector xmlns:android="http://schemas.android.com/apk/res/android" xmlns:aapt="http://schemas.android.com/aapt" ' +
        `android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24"${attrs}>` +
        `${body}</vector>`
    );
}

const svg24 = (body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;

/** Left half of the viewport filled with `color`. */
const HALF = (color: string) => `<path android:pathData="M0,0h12v24h-12z" android:fillColor="${color}"/>`;
const HALF_SVG = (fill: string) => `<path d="M0,0h12v24h-12z" fill="${fill}"/>`;

describe('vectorDrawableToSvg: converted fixtures round-trip', () => {
    const fixtures = [
        'clip-path.svg',
        'linear-gradient.svg',
        'radial-gradient-transform.svg',
        'skew-group.svg',
        'stroke-icon.svg',
    ];
    for (const file of fixtures) {
        it(`${file} renders like its source`, () => {
            const svg = fixture(file);
            const result = compareSvgs(svg, vectorDrawableToSvg(convert(svg).xml));
            expect(result.sizeMismatch).toBeNull();
            expect(result.inked).toBeGreaterThan(0);
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        });
    }

    it('default output is byte-identical to the harness vdToSvg', () => {
        for (const file of fixtures) {
            const xml = convert(fixture(file)).xml;
            expect(vectorDrawableToSvg(xml)).toBe(vdToSvg(xml));
        }
    });
});

describe('vectorDrawableToSvg: options', () => {
    it('maps dp 1:1 to px by default and scales by density, keeping the viewBox', () => {
        const xml = vd(HALF('#FF000000'), '').replace('android:width="24dp"', 'android:width="48dp"');
        const base = vectorDrawableToSvg(xml);
        expect(base).toContain('width="48" height="24" viewBox="0 0 24 24"');
        const x4 = vectorDrawableToSvg(xml, { density: 4 });
        expect(x4).toContain('width="192" height="96" viewBox="0 0 24 24"');
        const raster = renderSvg(x4, 192);
        expect([raster.width, raster.height]).toEqual([192, 96]);
    });

    it('ignores android:tint unless applyTint is set', () => {
        const xml = vd(HALF('#FF000000'), ' android:tint="#FFFF0000"');
        expect(vectorDrawableToSvg(xml)).not.toContain('filter');
        expect(compareSvgs(svg24(HALF_SVG('#000')), vectorDrawableToSvg(xml)).mismatch).toBe(0);
    });

    it('applies the tint with the default src_in mode (recolors drawn pixels only)', () => {
        const out = vectorDrawableToSvg(vd(HALF('#FF000000'), ' android:tint="#FFFF0000"'), { applyTint: true });
        expect(compareSvgs(svg24(HALF_SVG('#f00')), out).mismatch).toBe(0);
    });

    it('supports the other tint modes with PorterDuff semantics', () => {
        const black = HALF('#FF000000');
        const white = HALF('#FFFFFFFF');
        const cases: [string, string, string][] = [
            // src_over draws the tint over the whole bounds, transparent pixels included.
            [black, 'src_over', '<rect width="24" height="24" fill="#f00"/>'],
            [black, 'src_atop', HALF_SVG('#f00')],
            // multiply: white × red = red; screen: black ⊕ red = red; add: black + red = red.
            [white, 'multiply', HALF_SVG('#f00')],
            [black, 'screen', '<rect width="24" height="24" fill="#f00"/>'],
            [black, 'add', '<rect width="24" height="24" fill="#f00"/>'],
        ];
        for (const [body, mode, expected] of cases) {
            const xml = vd(body, ` android:tint="#FFFF0000" android:tintMode="${mode}"`);
            expect(compareSvgs(svg24(expected), vectorDrawableToSvg(xml, { applyTint: true })).mismatch, mode).toBe(0);
        }
    });

    it('applies the vector alpha on top of the tint', () => {
        const xml = vd(HALF('#FF000000'), ' android:tint="#FFFF0000" android:alpha="0.5"');
        const expected = svg24('<path d="M0,0h12v24h-12z" fill="#f00" fill-opacity="0.5"/>');
        expect(compareSvgs(expected, vectorDrawableToSvg(xml, { applyTint: true })).mismatch).toBe(0);
    });

    it('is a no-op when applyTint is set but the vector has no tint', () => {
        const xml = vd(HALF('#FF000000'));
        expect(vectorDrawableToSvg(xml, { applyTint: true })).toBe(vectorDrawableToSvg(xml));
    });
});

describe('vectorDrawableToSvg: unsupported input throws a clear Error', () => {
    const gradient = (type: string) =>
        `<path android:pathData="M0,0h24v24h-24z"><aapt:attr name="android:fillColor">` +
        `<gradient android:type="${type}" android:startColor="#FF000000" android:endColor="#FFFFFFFF"/>` +
        `</aapt:attr></path>`;
    const cases: [string, () => string, RegExp][] = [
        ['a sweep gradient', () => vectorDrawableToSvg(vd(gradient('sweep'))), /sweep.*no SVG equivalent/],
        ['a color resource', () => vectorDrawableToSvg(vd(HALF('@color/red'))), /Unsupported Android color: @color/],
        [
            'a theme tint with applyTint',
            () =>
                vectorDrawableToSvg(vd(HALF('#000'), ' android:tint="?attr/colorControlNormal"'), { applyTint: true }),
            /Unsupported Android color: \?attr/,
        ],
        [
            'an unknown tintMode',
            () =>
                vectorDrawableToSvg(vd(HALF('#000'), ' android:tint="#f00" android:tintMode="xor"'), {
                    applyTint: true,
                }),
            /tintMode="xor"/,
        ],
        ['an unknown element', () => vectorDrawableToSvg(vd('<text/>')), /Unsupported VectorDrawable element <text>/],
        ['a non-vector root', () => vectorDrawableToSvg('<svg/>'), /expected <vector>/],
        ['mismatched tags', () => vectorDrawableToSvg('<vector><group></vector>'), /Mismatched <\/vector>/],
        ['an empty document', () => vectorDrawableToSvg('<?xml version="1.0"?>'), /Empty XML document/],
        [
            'a missing viewport',
            () => vectorDrawableToSvg('<vector android:width="24dp" android:height="24dp"/>'),
            /viewportWidth/,
        ],
        ['a non-numeric attribute', () => vectorDrawableToSvg(vd('', ' android:alpha="half"')), /android:alpha="half"/],
        ['a non-positive density', () => vectorDrawableToSvg(vd(''), { density: 0 }), /density/],
    ];
    for (const [label, run, message] of cases) {
        it(label, () => expect(run).toThrow(message));
    }
});

describe('vectorDrawableToSvg: packaging', () => {
    it('is exported by the browser entry (same function as the Node entry)', () => {
        expect(browser.vectorDrawableToSvg).toBe(vectorDrawableToSvg);
    });

    it('has no import at all (independent of the converter, no Node built-in)', () => {
        const source = readFileSync(join(here, '..', 'src', 'preview.ts'), 'utf8');
        expect(source).not.toMatch(/^\s*import\b/m);
        expect(source).not.toMatch(/\brequire\(|\bimport\(/);
    });
});
