import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, vectorDrawableToSvg } from '../src/index.js';
import { hasUnrenderedTrim, UNRESOLVED_COLOR } from '../src/preview.js';
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

describe('vectorDrawableToSvg: color references', () => {
    /** Renders `xml` with `options`, returning the SVG and the references reported as unresolved. */
    function preview(xml: string, colors?: Record<string, string>, applyTint = false) {
        const unresolved: string[] = [];
        const svg = vectorDrawableToSvg(xml, { colors, applyTint, onUnresolvedColor: (r) => unresolved.push(r) });
        return { svg, unresolved };
    }

    it('draws a mapped ?attr/ reference in its preview color', () => {
        const { svg, unresolved } = preview(vd(HALF('?attr/x')), { '?attr/x': '#f00' });
        expect(compareSvgs(svg24(HALF_SVG('#f00')), svg).mismatch).toBe(0);
        expect(unresolved).toEqual([]);
    });

    it('draws an unmapped reference in neutral gray, reported once, without throwing', () => {
        const xml = vd(HALF('?attr/x') + '<path android:pathData="M12,0h12v24h-12z" android:fillColor="?attr/x"/>');
        const { svg, unresolved } = preview(xml);
        expect(UNRESOLVED_COLOR).toBe('#FF808080');
        expect(svg).toContain('fill="#808080"');
        expect(compareSvgs(svg24('<rect width="24" height="24" fill="#808080"/>'), svg).mismatch).toBe(0);
        expect(unresolved).toEqual(['?attr/x']);
        expect(() => vectorDrawableToSvg(xml)).not.toThrow();
    });

    it('reports only the references missing from the map, in order of appearance', () => {
        const xml = vd(
            HALF('@color/b') +
                '<path android:pathData="M12,0h12v24h-12z" android:strokeColor="?android:attr/a" android:strokeWidth="1" android:fillColor="@color/brand"/>',
        );
        expect(preview(xml, { '@color/brand': '#00f' }).unresolved).toEqual(['@color/b', '?android:attr/a']);
    });

    it('resolves references in strokes, gradient stops and the tint', () => {
        const colors = { '@color/red': '#FFFF0000', '?attr/blue': '#0000ff' };
        const stroke = preview(
            vd('<path android:pathData="M0,12h24" android:strokeColor="@color/red" android:strokeWidth="2"/>'),
            colors,
        ).svg;
        expect(stroke).toContain('stroke="#ff0000"');
        const gradient = preview(
            vd(
                '<path android:pathData="M0,0h24v24h-24z"><aapt:attr name="android:fillColor">' +
                    '<gradient android:startColor="@color/red" android:endColor="#FF00FF00" android:endX="24">' +
                    '<item android:offset="0" android:color="@color/red"/><item android:offset="1" android:color="?attr/blue"/>' +
                    '</gradient></aapt:attr></path>',
            ),
            colors,
        ).svg;
        expect(gradient).toContain(
            '<stop offset="0" stop-color="#ff0000" stop-opacity="1"/><stop offset="1" stop-color="#0000ff"',
        );
        const tinted = preview(vd(HALF('#000'), ' android:tint="?attr/blue"'), colors, true).svg;
        expect(compareSvgs(svg24(HALF_SVG('#00f')), tinted).mismatch).toBe(0);
        expect(preview(vd(HALF('#000'), ' android:tint="?attr/blue"'), colors).svg).not.toContain('filter');
    });

    it('reads mapped values as Android literals (alpha first), multiplied by fillAlpha', () => {
        const xml = vd(HALF('@color/half').replace('/>', ' android:fillAlpha="0.5"/>'));
        const svg = preview(xml, { '@color/half': '#80FF0000' }).svg;
        expect(svg).toContain(`fill="#ff0000" fill-opacity="${(0x80 / 255) * 0.5}"`);
    });

    it('rejects a malformed colors key or value with a TypeError (nothing is copied verbatim)', () => {
        const xml = vd(HALF('?attr/x'));
        const bad: Record<string, string>[] = [
            { 'attr/x': '#f00' },
            { '?attr/x': 'red' },
            { '?attr/x': '#f00" onload="alert(1)' },
            { '?attr/x': '?attr/y' },
            { '?attr/x': '#12345' },
        ];
        for (const colors of bad)
            expect(() => vectorDrawableToSvg(xml, { colors }), JSON.stringify(colors)).toThrow(TypeError);
        // @ts-expect-error runtime check of a JavaScript caller
        expect(() => vectorDrawableToSvg(xml, { colors: '#f00' })).toThrow(TypeError);
    });

    it('leaves the output of drawables without references unchanged', () => {
        const colors = { '?attr/x': '#f00' };
        for (const file of ['clip-path.svg', 'linear-gradient.svg', 'stroke-icon.svg']) {
            const xml = convert(fixture(file)).xml;
            const { svg, unresolved } = preview(xml, colors);
            expect(svg).toBe(vectorDrawableToSvg(xml));
            expect(unresolved).toEqual([]);
        }
    });

    it('previews a converter output with theme references end to end', () => {
        const source =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h12v24H0z" fill="currentColor"/></svg>';
        const xml = convert(source, { currentColor: '?attr/colorPrimary' }).xml;
        expect(xml).toContain('?attr/colorPrimary');
        const { svg } = preview(xml, { '?attr/colorPrimary': '#f00' });
        expect(compareSvgs(svg24(HALF_SVG('#f00')), svg).mismatch).toBe(0);
    });
});

describe('vectorDrawableToSvg: trimmed paths (T-187)', () => {
    /** A square of perimeter 64 starting at (4,4) clockwise, then a second contour Android does not trim. */
    const SQUARE = 'M4,4H20V20H4Z M8,10H16';
    const stroked = (trim: string, extra = '') =>
        vd(
            `<path android:pathData="${SQUARE}" android:strokeColor="#FF000000" android:strokeWidth="2" ${trim}${extra}/>`,
        );
    /** The expected SVG: `d` stroked like the drawable (butt caps, miter joins). */
    const strokedSvg = (d: string) =>
        svg24(`<path d="${d}" fill="none" stroke="#000" stroke-width="2" stroke-miterlimit="4"/>`);
    const attrsOf = (svg: string) => /<path ([^>]*)\/>/.exec(svg)![1]!;

    it('draws from trimPathStart to the end of the first contour', () => {
        const svg = vectorDrawableToSvg(stroked('android:trimPathStart="0.25"'));
        expect(attrsOf(svg)).toContain(
            'd="M4,4H20V20H4Z" fill="none" stroke="#000000" stroke-width="2" stroke-linecap="butt" ' +
                'stroke-linejoin="miter" stroke-miterlimit="4" stroke-dasharray="48 64" stroke-dashoffset="-16"',
        );
        expect(compareSvgs(strokedSvg('M20,4V20H4V4'), svg).mismatch).toBe(0);
    });

    it('draws from the start to trimPathEnd, with no dash offset', () => {
        const svg = vectorDrawableToSvg(stroked('android:trimPathEnd="0.5"'));
        expect(attrsOf(svg)).toContain('stroke-miterlimit="4" stroke-dasharray="32 64"');
        expect(svg).not.toContain('stroke-dashoffset');
        expect(compareSvgs(strokedSvg('M4,4H20V20'), svg).mismatch).toBe(0);
    });

    it('draws the window between trimPathStart and trimPathEnd', () => {
        const svg = vectorDrawableToSvg(stroked('android:trimPathStart="0.125" android:trimPathEnd="0.625"'));
        expect(attrsOf(svg)).toContain('stroke-dasharray="32 64" stroke-dashoffset="-8"');
        expect(compareSvgs(strokedSvg('M12,4H20V20H12'), svg).mismatch).toBe(0);
    });

    it('wraps a window shifted past the end by trimPathOffset into two dashes', () => {
        // (0.5 + 0.375, 0.9 + 0.375) mod 1 = [0.875, 1] then [0, 0.275].
        const xml = stroked('android:trimPathStart="0.5" android:trimPathEnd="0.9" android:trimPathOffset="0.375"');
        const svg = vectorDrawableToSvg(xml);
        expect(attrsOf(svg)).toContain('stroke-dasharray="17.6 38.4 8 64"');
        expect(svg).not.toContain('stroke-dashoffset');
        // On a closed contour, SVG renderers join the two dashes at the start point (Android leaves
        // two butt ends there, a notch at this corner): the only difference, documented in preview.ts.
        expect(compareSvgs(strokedSvg('M4,12V4H20V5.6'), svg).mismatch).toBe(0);
    });

    it('wraps trimPathStart > trimPathEnd too, as Android does', () => {
        const svg = vectorDrawableToSvg(stroked('android:trimPathStart="0.75" android:trimPathEnd="0.25"'));
        expect(attrsOf(svg)).toContain('stroke-dasharray="16 32 16 64"');
        expect(compareSvgs(strokedSvg('M4,20V4H20'), svg).mismatch).toBe(0);
    });

    it('draws nothing when the window is empty', () => {
        for (const trim of [
            'android:trimPathStart="0.4" android:trimPathEnd="0.4"',
            'android:trimPathStart="0.25" android:trimPathEnd="0.25" android:trimPathOffset="0.5"',
        ]) {
            const svg = vectorDrawableToSvg(stroked(trim));
            expect(svg, trim).not.toContain('stroke=');
            expect(
                renderSvg(svg).pixels.some((v) => v !== 0),
                trim,
            ).toBe(false);
        }
    });

    it('adds nothing for the defaults, nor for an offset alone (Android ignores it)', () => {
        const whole = vectorDrawableToSvg(stroked(''));
        expect(whole).not.toContain('stroke-dash');
        expect(whole).toContain(`d="${SQUARE}"`);
        for (const trim of ['android:trimPathStart="0" android:trimPathEnd="1"', 'android:trimPathOffset="0.3"']) {
            expect(vectorDrawableToSvg(stroked(trim)), trim).toBe(whole);
        }
    });

    it('keeps the round caps of the drawable at both ends of the window', () => {
        const svg = vectorDrawableToSvg(
            stroked('android:trimPathStart="0.25" android:trimPathEnd="0.5"', ' android:strokeLineCap="round"'),
        );
        const expected = svg24(
            '<path d="M20,4V20" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round"/>',
        );
        expect(compareSvgs(expected, svg).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
    });

    it('draws a filled trimmed path whole (Android fills the trimmed geometry: no SVG equivalent)', () => {
        const filled = (trim: string) =>
            vd(
                `<path android:pathData="${SQUARE}" android:fillColor="#FFFF0000" android:strokeColor="#FF000000" ` +
                    `android:strokeWidth="2" ${trim}/>`,
            );
        const svg = vectorDrawableToSvg(filled('android:trimPathStart="0.25" android:trimPathEnd="0.5"'));
        expect(svg).toBe(vectorDrawableToSvg(filled('')));
        expect(svg).not.toContain('stroke-dash');
    });

    it('measures curves and arcs, in absolute lengths (resvg ignores pathLength)', () => {
        // A circle of radius 8 (length 16π ≈ 50.2655) as two arcs, then the same as two cubics.
        const circle = 'M4,12a8,8 0 1,1 16,0a8,8 0 1,1 -16,0z';
        const svg = vectorDrawableToSvg(
            vd(
                `<path android:pathData="${circle}" android:strokeColor="#FF000000" android:strokeWidth="2" ` +
                    'android:trimPathEnd="0.5"/>',
            ),
        );
        const [half, whole] = /stroke-dasharray="([\d.]+) ([\d.]+)"/.exec(svg)!.slice(1).map(Number);
        expect(half).toBeCloseTo(8 * Math.PI, 2);
        expect(whole).toBeCloseTo(16 * Math.PI, 2);
        expect(svg).not.toContain('pathLength');
        const upperHalf = svg24('<path d="M4,12a8,8 0 1,1 16,0" fill="none" stroke="#000" stroke-width="2"/>');
        expect(compareSvgs(upperHalf, svg).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
    });
});

describe('hasUnrenderedTrim', () => {
    it('is true only for a filled path with an effective trim', () => {
        const path = (attrs: string, body = '') =>
            vd(`<group><path android:pathData="M0,0h24v24h-24z" ${attrs}>${body}</path></group>`);
        const gradient =
            '<aapt:attr name="android:fillColor"><gradient android:startColor="#FF000000" android:endColor="#FFFFFFFF"/></aapt:attr>';
        expect(hasUnrenderedTrim(path('android:fillColor="#FF000000" android:trimPathEnd="0.5"'))).toBe(true);
        expect(hasUnrenderedTrim(path('android:trimPathStart="0.1"', gradient))).toBe(true);
        expect(hasUnrenderedTrim(path('android:fillColor="#FF000000"'))).toBe(false);
        expect(hasUnrenderedTrim(path('android:fillColor="#FF000000" android:trimPathOffset="0.5"'))).toBe(false);
        expect(
            hasUnrenderedTrim(
                path('android:strokeColor="#FF000000" android:strokeWidth="1" android:trimPathEnd="0.5"'),
            ),
        ).toBe(false);
    });
});

describe('vectorDrawableToSvg: unsupported input throws a clear Error', () => {
    const gradient = (type: string) =>
        `<path android:pathData="M0,0h24v24h-24z"><aapt:attr name="android:fillColor">` +
        `<gradient android:type="${type}" android:startColor="#FF000000" android:endColor="#FFFFFFFF"/>` +
        `</aapt:attr></path>`;
    const cases: [string, () => string, RegExp][] = [
        ['a sweep gradient', () => vectorDrawableToSvg(vd(gradient('sweep'))), /sweep.*no SVG equivalent/],
        ['a color name', () => vectorDrawableToSvg(vd(HALF('red'))), /Unsupported Android color: red/],
        [
            'a malformed reference (not a color resource)',
            () => vectorDrawableToSvg(vd(HALF('@drawable/red'))),
            /Unsupported Android color: @drawable\/red/,
        ],
        [
            'a reference without its type',
            () => vectorDrawableToSvg(vd(HALF('#000'), ' android:tint="?colorControlNormal"'), { applyTint: true }),
            /Unsupported Android color: \?colorControlNormal/,
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
        [
            'a non-numeric size',
            () => vectorDrawableToSvg(vd('').replace('android:width="24dp"', 'android:width="abc"')),
            /android:width="abc" is not a positive size/,
        ],
        [
            'a character reference outside Unicode',
            () => vectorDrawableToSvg(vd('<path android:pathData="&#x110000;"/>')),
            /Invalid character reference &#x110000;/,
        ],
    ];
    for (const [label, run, message] of cases) {
        it(label, () => expect(run).toThrow(message));
    }
});

describe('vectorDrawableToSvg: attribute values are never copied verbatim into the SVG', () => {
    const stroked = (attr: string) =>
        vd(`<path android:pathData="M0 0h9v9z" android:strokeColor="#000" android:strokeWidth="1" ${attr}/>`);

    it.each(['strokeLineCap', 'strokeLineJoin'])('rejects an injected android:%s', (name) => {
        const xml = stroked(`android:${name}="round&quot; onload=&quot;alert(1)"`);
        expect(() => vectorDrawableToSvg(xml)).toThrow(`Unsupported android:${name}`);
    });

    it('keeps the valid keywords', () => {
        const svg = vectorDrawableToSvg(stroked('android:strokeLineCap="square" android:strokeLineJoin="bevel"'));
        expect(svg).toContain('stroke-linecap="square" stroke-linejoin="bevel"');
    });
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
