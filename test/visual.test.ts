import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';
import { vdToSvg, parseAndroidColor } from './visual/vdToSvg.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';

// Visual regression: every fixture is converted, the VectorDrawable is re-serialized to SVG and both
// are rendered by resvg; the renders must match (thresholds documented in test/visual/compare.ts).
const dir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');
const files = readdirSync(dir)
    .filter((f) => f.endsWith('.svg'))
    .sort();

/**
 * Fixtures using a feature the converter drops *by design* (with a warning) are compared against a
 * variant of the source that models the documented loss — never by loosening the threshold.
 */
const REFERENCE_VARIANTS: Record<string, (svg: string) => string> = {
    // Dashes are baked into geometry and must match exactly. Group `opacity` is folded onto each
    // leaf's fill / stroke alpha (warning `opacity-approximated`), which is exactly what inherited
    // fill-/stroke-opacity do.
    'issue-1-react-logo.svg': (svg) => svg.replace(/\bopacity="0\.2"/, 'fill-opacity="0.2" stroke-opacity="0.2"'),
};

function source(file: string): string {
    return readFileSync(join(dir, file), 'utf8');
}

describe('visual regression: fixtures render like their source', () => {
    for (const file of files) {
        for (const optimize of [true, false]) {
            it(`${file} (optimize: ${optimize})`, () => {
                const svg = source(file);
                const reference = (REFERENCE_VARIANTS[file] ?? ((s: string) => s))(svg);
                const result = compareSvgs(reference, vdToSvg(convert(svg, { optimize }).xml));
                expect(result.sizeMismatch).toBeNull();
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });
        }
    }

    it('renders the dashed issue #1 logo like its raw source (dashes baked into geometry)', () => {
        const svg = source('issue-1-react-logo.svg');
        for (const optimize of [true, false]) {
            const result = compareSvgs(svg, vdToSvg(convert(svg, { optimize }).xml));
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        }
    });
});

describe('visual regression: the harness detects wrong output', () => {
    const svg = source('issue-1-react-logo.svg');
    const reference = REFERENCE_VARIANTS['issue-1-react-logo.svg']!(svg);
    const xml = convert(svg).xml;

    it('a dropped path', () => {
        // Remove the last <path> (the dark triangle outline).
        const start = xml.lastIndexOf('<path');
        const broken = xml.slice(0, start) + xml.slice(xml.indexOf('/>', start) + 2);
        expect(broken).not.toBe(xml);
        expect(compareSvgs(reference, vdToSvg(broken)).mismatch).toBeGreaterThan(0.05);
    });

    it('a shifted group', () => {
        const broken = xml.replace('android:translateX="54"', 'android:translateX="56"');
        expect(broken).not.toBe(xml);
        expect(compareSvgs(reference, vdToSvg(broken)).mismatch).toBeGreaterThan(0.05);
    });

    it('a wrong color', () => {
        const broken = xml.replace(/#FF61DAFB/g, '#FF61DA00');
        expect(broken).not.toBe(xml);
        expect(compareSvgs(reference, vdToSvg(broken)).mismatch).toBeGreaterThan(0.05);
    });

    it('a dropped clip-path', () => {
        const broken = xml.replace(/<clip-path[^>]*\/>/, '');
        expect(broken).not.toBe(xml);
        expect(compareSvgs(reference, vdToSvg(broken)).mismatch).toBeGreaterThan(0.05);
    });
});

/** Wraps VectorDrawable children in a 24×24 `<vector>`. */
function vector(body: string): string {
    return (
        '<vector xmlns:android="http://schemas.android.com/apk/res/android" ' +
        'xmlns:aapt="http://schemas.android.com/aapt" android:width="24dp" android:height="24dp" ' +
        `android:viewportWidth="24" android:viewportHeight="24">${body}</vector>`
    );
}

/** Wraps SVG content in a 24×24 `<svg>`. */
function svg24(body: string): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;
}

describe('vdToSvg reproduces Android semantics', () => {
    it('parses Android color literals', () => {
        expect(parseAndroidColor('#80FF0000')).toEqual({ rgb: '#ff0000', opacity: 128 / 255 });
        expect(parseAndroidColor('#0F0')).toEqual({ rgb: '#00ff00', opacity: 1 });
        expect(parseAndroidColor('#8F00')).toEqual({ rgb: '#ff0000', opacity: 0x88 / 255 });
    });

    it('applies group scale → rotate → translate around the pivot', () => {
        const vd = vector(
            '<group android:pivotX="12" android:pivotY="12" android:rotation="90" android:scaleX="0.5" ' +
                'android:translateX="2"><path android:pathData="M4 4h16v4H4z" android:fillColor="#FF000000"/></group>',
        );
        // scale(0.5,1) around (12,12): x∈[8,16], y∈[4,8]; rotate 90° around (12,12): x∈[16,20], y∈[8,16]; +2 in x.
        const expected = svg24('<path d="M18 8h4v8h-4z"/>');
        expect(compareSvgs(expected, vdToSvg(vd)).mismatch).toBe(0);
    });

    it('clips only the siblings that follow a <clip-path>', () => {
        const vd = vector(
            '<group><path android:pathData="M0 0h24v4H0z" android:fillColor="#FF0000FF"/>' +
                '<clip-path android:pathData="M0 0h12v24H0z"/>' +
                '<path android:pathData="M0 10h24v4H0z" android:fillColor="#FFFF0000"/></group>',
        );
        const expected = svg24('<path d="M0 0h24v4H0z" fill="#00f"/><path d="M0 10h12v4H0z" fill="#f00"/>');
        expect(compareSvgs(expected, vdToSvg(vd)).mismatch).toBe(0);
    });

    it('multiplies color alpha by fillAlpha and maps strokes / gradients', () => {
        const vd = vector(
            '<path android:pathData="M2 2h20v20H2z" android:fillColor="#80FF0000" android:fillAlpha="0.5" ' +
                'android:strokeColor="#FF000000" android:strokeWidth="2" android:strokeLineJoin="round"/>' +
                '<path android:pathData="M6 6h12v12H6z"><aapt:attr name="android:fillColor">' +
                '<gradient android:type="linear" android:startX="6" android:startY="0" android:endX="12" ' +
                'android:endY="0" android:tileMode="mirror"><item android:offset="0" android:color="#FF00FF00"/>' +
                '<item android:offset="1" android:color="#FF0000FF"/></gradient></aapt:attr></path>',
        );
        const expected = svg24(
            '<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="6" y1="0" x2="12" y2="0" spreadMethod="reflect">' +
                '<stop stop-color="#0f0"/><stop offset="1" stop-color="#00f"/></linearGradient>' +
                `<path d="M2 2h20v20H2z" fill="#f00" fill-opacity="${(128 / 255) * 0.5}" stroke="#000" ` +
                'stroke-width="2" stroke-linejoin="round"/><path d="M6 6h12v12H6z" fill="url(#g)"/>',
        );
        expect(compareSvgs(expected, vdToSvg(vd)).mismatch).toBe(0);
    });

    it('draws no stroke without strokeWidth (Android default 0) and no fill without fillColor', () => {
        const vd = vector('<path android:pathData="M2 2h20v20H2z" android:strokeColor="#FF000000"/>');
        expect(compareSvgs(svg24(''), vdToSvg(vd)).inked).toBe(0);
    });
});
