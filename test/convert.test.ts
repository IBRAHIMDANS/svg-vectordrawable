import { describe, expect, it, vi } from 'vitest';
import { convert, ConversionError } from '../src/index.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';
import { vdToSvg } from './visual/vdToSvg.js';

const svg = (inner: string, attrs = 'viewBox="0 0 24 24"'): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;
// Most tests use optimize:false for deterministic output (svgo would rewrite paths/colors/transforms).
const raw = { optimize: false };

describe('basic paths & colors', () => {
    it('emits an opaque fillColor for a hex fill', () => {
        const { xml } = convert(svg('<path d="M0 0h24v24H0z" fill="#ff0000"/>'), raw);
        expect(xml).toContain('android:pathData="M0 0h24v24H0z"');
        expect(xml).toContain('android:fillColor="#FFFF0000"');
    });

    it('defaults unfilled paths to black (SVG default)', () => {
        const { xml } = convert(svg('<path d="M0 0h1v1z"/>'), raw);
        expect(xml).toContain('android:fillColor="#FF000000"');
    });

    it('omits fill for fill="none"', () => {
        const { xml } = convert(svg('<path d="M0 0h1v1z" fill="none"/>'), raw);
        expect(xml).not.toContain('android:fillColor');
    });

    it('resolves named, rgb() and hsl() colors', () => {
        expect(convert(svg('<path d="M0 0z" fill="red"/>'), raw).xml).toContain('#FFFF0000');
        expect(convert(svg('<path d="M0 0z" fill="rgb(0,128,0)"/>'), raw).xml).toContain('#FF008000');
        expect(convert(svg('<path d="M0 0z" fill="hsl(240,100%,50%)"/>'), raw).xml).toContain('#FF0000FF');
    });

    it('substitutes currentColor', () => {
        const { xml } = convert(svg('<path d="M0 0z" fill="currentColor"/>'), {
            optimize: false,
            currentColor: '#112233',
        });
        expect(xml).toContain('android:fillColor="#FF112233"');
    });

    it('maps fill-rule="evenodd" to fillType', () => {
        const { xml } = convert(svg('<path d="M0 0z" fill="#000" fill-rule="evenodd"/>'), raw);
        expect(xml).toContain('android:fillType="evenOdd"');
    });
});

describe('shapes → path', () => {
    it('converts a <rect> with rounded corners', () => {
        const { xml } = convert(svg('<rect x="0" y="0" width="10" height="10" rx="2" fill="#000"/>'), raw);
        expect(xml).toContain('<path');
        expect(xml).toContain('android:pathData="M2,0');
    });

    it('converts a <circle>', () => {
        const { xml } = convert(svg('<circle cx="5" cy="5" r="4" fill="#000"/>'), raw);
        expect(xml).toMatch(/android:pathData="M1,5a4,4/);
    });
});

describe('gradients', () => {
    it('renders a linear gradient as an aapt block', () => {
        const { xml } = convert(
            svg(
                '<defs><linearGradient id="g" x1="0" y1="0" x2="24" y2="0" gradientUnits="userSpaceOnUse">' +
                    '<stop stop-color="#504E9C"/><stop offset="1" stop-color="#07B8D8"/></linearGradient></defs>' +
                    '<path d="M0 0h24v24H0z" fill="url(#g)"/>',
            ),
            raw,
        );
        expect(xml).toContain('xmlns:aapt="http://schemas.android.com/aapt"');
        expect(xml).toContain('android:type="linear"');
        expect(xml).toContain('android:startX="0"');
        expect(xml).toContain('android:endX="24"');
        expect(xml).toContain('android:color="#FF504E9C"');
        expect(xml).toContain('android:color="#FF07B8D8"');
        expect(xml).not.toContain('android:fillColor="#FF000000"');
    });

    it('bakes gradientTransform into a radial gradient (the svg2vectordrawable gap)', () => {
        const { xml } = convert(
            svg(
                '<defs><radialGradient id="r" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" ' +
                    'gradientTransform="translate(7 5) rotate(90) scale(28)">' +
                    '<stop stop-color="#fff"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient></defs>' +
                    '<path d="M0 0h24v24H0z" fill="url(#r)"/>',
            ),
            raw,
        );
        expect(xml).toContain('android:type="radial"');
        expect(xml).toContain('android:centerX="7"');
        expect(xml).toContain('android:centerY="5"');
        expect(xml).toContain('android:gradientRadius="28"');
        expect(xml).toContain('android:color="#FFFFFFFF"');
        expect(xml).toContain('android:color="#00000000"');
    });

    it('maps an objectBoundingBox gradient through the path bounding box', () => {
        const { xml } = convert(
            svg(
                '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
                    '<path d="M0 0h10v10h-10z" fill="url(#g)"/>',
            ),
            raw,
        );
        // default objectBoundingBox: x2=1 maps to bbox width (10), x1=0 to 0
        expect(xml).toContain('android:type="linear"');
        expect(xml).toContain('android:startX="0"');
        expect(xml).toContain('android:endX="10"');
    });

    it('warns and falls back to black on a missing gradient', () => {
        const onWarn = vi.fn();
        const { xml } = convert(svg('<path d="M0 0z" fill="url(#nope)"/>'), { optimize: false, onWarn });
        expect(xml).toContain('android:fillColor="#FF000000"');
        expect(onWarn).toHaveBeenCalledWith(expect.objectContaining({ code: 'missing-gradient' }));
    });
});

describe('gradient strokes', () => {
    const linearDef =
        '<linearGradient id="g" x1="0" y1="0" x2="24" y2="0" gradientUnits="userSpaceOnUse">' +
        '<stop stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>';
    const radialDef =
        '<radialGradient id="r" cx="12" cy="12" r="10" gradientUnits="userSpaceOnUse">' +
        '<stop stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>';
    const codes = (xml: string): string[] => convert(xml, raw).warnings.map((w) => w.code);
    /** The `<aapt:attr>` blocks of the output, keyed by their target attribute. */
    const blocks = (xml: string): Record<string, string> =>
        Object.fromEntries(
            [...xml.matchAll(/<aapt:attr name="android:(\w+)">([\s\S]*?)<\/aapt:attr>/g)].map((m) => [m[1]!, m[2]!]),
        );

    it('renders a linear gradient stroke as a strokeColor aapt block', () => {
        const doc = svg(`<defs>${linearDef}</defs><path d="M2 12h20" fill="none" stroke="url(#g)" stroke-width="2"/>`);
        const { xml, warnings } = convert(doc, raw);
        expect(warnings).toEqual([]);
        expect(xml).toContain('xmlns:aapt="http://schemas.android.com/aapt"');
        expect(xml).toContain('android:strokeWidth="2"');
        expect(xml).not.toMatch(/android:strokeColor="/);
        expect(xml).not.toContain('android:fillColor');
        const b = blocks(xml);
        expect(Object.keys(b)).toEqual(['strokeColor']);
        expect(b.strokeColor).toContain('android:type="linear"');
        expect(b.strokeColor).toContain('android:startX="0"');
        expect(b.strokeColor).toContain('android:endX="24"');
        expect(b.strokeColor).toContain('android:color="#FFFF0000"');
        expect(b.strokeColor).toContain('android:color="#FF0000FF"');
    });

    it('renders a radial gradient stroke', () => {
        const doc = svg(`<defs>${radialDef}</defs><circle cx="12" cy="12" r="8" fill="none" stroke="url(#r)"/>`);
        const { xml, warnings } = convert(doc, raw);
        expect(warnings).toEqual([]);
        const b = blocks(xml);
        expect(Object.keys(b)).toEqual(['strokeColor']);
        expect(b.strokeColor).toContain('android:type="radial"');
        expect(b.strokeColor).toContain('android:centerX="12"');
        expect(b.strokeColor).toContain('android:gradientRadius="10"');
        expect(xml).toContain('android:strokeWidth="1"');
    });

    it('emits both a fill and a stroke gradient on the same path', () => {
        const doc = svg(
            `<defs>${linearDef}${radialDef}</defs><path d="M2 2h20v20H2z" fill="url(#r)" stroke="url(#g)" stroke-width="3"/>`,
        );
        const { xml, warnings } = convert(doc, raw);
        expect(warnings).toEqual([]);
        const b = blocks(xml);
        expect(Object.keys(b)).toEqual(['fillColor', 'strokeColor']);
        expect(b.fillColor).toContain('android:type="radial"');
        expect(b.strokeColor).toContain('android:type="linear"');
        expect(xml.match(/xmlns:aapt=/g)).toHaveLength(1);
        expect(xml).toMatch(/android:strokeWidth="3">\n/); // attributes close before the children
        expect(xml).toMatch(/<\/aapt:attr>\n\s*<\/path>/);
    });

    it('maps an objectBoundingBox stroke gradient through the geometry bounding box (not the stroke extent)', () => {
        const doc = svg(
            '<defs><linearGradient id="b"><stop stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>' +
                '<path d="M4 2h10v10H4z" fill="none" stroke="url(#b)" stroke-width="4"/>',
        );
        const b = blocks(convert(doc, raw).xml);
        expect(b.strokeColor).toContain('android:startX="4"');
        expect(b.strokeColor).toContain('android:startY="2"');
        expect(b.strokeColor).toContain('android:endX="14"');
        expect(b.strokeColor).toContain('android:endY="2"');
    });

    it('keeps strokeAlpha, line cap/join, miter limit and opacity folding as for a color stroke', () => {
        const attrs =
            'fill="none" stroke-width="2" stroke-opacity="0.5" opacity="0.5" stroke-linecap="round" ' +
            'stroke-linejoin="bevel" stroke-miterlimit="6"';
        const gradient = convert(
            svg(`<defs>${linearDef}</defs><path d="M2 12h20" stroke="url(#g)" ${attrs}/>`),
            raw,
        ).xml;
        const color = convert(svg(`<path d="M2 12h20" stroke="#f00" ${attrs}/>`), raw).xml;
        const strokeAttrs = (xml: string): string[] => (xml.match(/android:stroke(?!Color)\w+="[^"]*"/g) ?? []).sort();
        expect(strokeAttrs(gradient)).toEqual(strokeAttrs(color));
        expect(gradient).toContain('android:strokeAlpha="0.25"');
        expect(gradient).toContain('android:strokeLineCap="round"');
        expect(gradient).toContain('android:strokeLineJoin="bevel"');
    });

    it('warns on dash arrays and opacity on fill+stroke exactly as for a color stroke', () => {
        const dashed = `<defs>${linearDef}</defs><path d="M2 12h20" fill="none" stroke="url(#g)" stroke-dasharray="1em"/>`;
        expect(codes(svg(dashed))).toEqual(['unsupported-stroke-dasharray']);
        const both = `<defs>${linearDef}</defs><path d="M2 2h20v20H2z" fill="#0f0" stroke="url(#g)" opacity="0.5"/>`;
        expect(codes(svg(both))).toEqual(['opacity-approximated']);
    });

    it('never reports unsupported-stroke-gradient for a resolvable gradient, even with a fallback color', () => {
        const doc = svg(`<defs>${linearDef}</defs><path d="M2 12h20" fill="none" stroke="url(#g) #0f0"/>`);
        const { xml, warnings } = convert(doc, raw);
        expect(warnings.map((w) => w.code)).not.toContain('unsupported-stroke-gradient');
        expect(xml).not.toContain('#FF00FF00'); // the gradient wins over the fallback
        expect(Object.keys(blocks(xml))).toEqual(['strokeColor']);
    });

    it('warns once on gradient-under-skew when fill and stroke gradients are baked', () => {
        const doc = svg(
            `<defs>${linearDef}</defs><g transform="skewX(20)"><path d="M2 2h20v20H2z" fill="url(#g)" stroke="url(#g)"/></g>`,
        );
        const { xml, warnings } = convert(doc, raw);
        expect(warnings.filter((w) => w.code === 'gradient-under-skew')).toHaveLength(1);
        expect(Object.keys(blocks(xml))).toEqual(['fillColor', 'strokeColor']);
    });

    it('warns gradient-approximated for an elliptical radial stroke gradient', () => {
        const doc = svg(
            '<defs><radialGradient id="e" gradientTransform="scale(1 0.5)"><stop stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient></defs>' +
                '<path d="M2 2h20v20H2z" fill="none" stroke="url(#e)"/>',
        );
        expect(codes(doc)).toEqual(['gradient-approximated']);
    });

    it('keeps unsupported-paint for a <pattern> stroke (fallback color applies)', () => {
        const pattern = '<pattern id="p" width="2" height="2"><rect width="1" height="1"/></pattern>';
        const withFallback = convert(svg(`${pattern}<path d="M0 0h4" fill="none" stroke="url(#p) red"/>`), raw);
        expect(withFallback.warnings.map((w) => w.code)).toEqual(['unsupported-paint']);
        expect(withFallback.xml).toContain('android:strokeColor="#FFFF0000"');
        const without = convert(svg(`${pattern}<path d="M0 0h4" fill="none" stroke="url(#p)"/>`), raw);
        expect(without.warnings.map((w) => w.code)).toEqual(['unsupported-paint']);
        expect(without.xml).not.toContain('android:strokeColor');
    });

    it('keeps the missing-paint behaviour for an unknown stroke reference', () => {
        const dropped = convert(svg('<path d="M0 0h4" fill="none" stroke="url(#nope)"/>'), raw);
        expect(dropped.warnings.map((w) => w.code)).toEqual(['missing-gradient']);
        expect(dropped.xml).not.toContain('android:strokeColor');
        expect(dropped.xml).not.toContain('aapt');
        const fallback = convert(svg('<path d="M0 0h4" fill="none" stroke="url(#nope) #00f"/>'), raw);
        expect(fallback.warnings).toEqual([]);
        expect(fallback.xml).toContain('android:strokeColor="#FF0000FF"');
    });
});

describe('inheritance & groups', () => {
    it('inherits fill from a parent <g>', () => {
        const { xml } = convert(svg('<g fill="#f00"><path d="M0 0h1v1z"/></g>'), raw);
        expect(xml).toContain('android:fillColor="#FFFF0000"');
    });

    it('maps a <g transform> to an Android <group>', () => {
        const { xml } = convert(svg('<g transform="translate(2 3)"><path d="M0 0h1v1z" fill="#000"/></g>'), raw);
        expect(xml).toContain('<group');
        expect(xml).toContain('android:translateX="2"');
        expect(xml).toContain('android:translateY="3"');
    });

    it('inherits presentation attributes set on the <svg> root (Feather/Bootstrap style)', () => {
        const { xml } = convert(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
                '<path d="M2 12h20"/></svg>',
            { optimize: false, currentColor: '#123456' },
        );
        expect(xml).toContain('android:strokeColor="#FF123456"');
        expect(xml).toContain('android:strokeWidth="2"');
        expect(xml).toContain('android:strokeLineCap="round"');
        expect(xml).not.toContain('android:fillColor'); // fill="none" inherited from <svg>
    });

    it('resolves <use> references by inlining them', () => {
        const onWarn = vi.fn();
        const { xml } = convert(svg('<defs><path id="p" d="M0 0h8v8z"/></defs><use href="#p" fill="#0a0"/>'), {
            optimize: false,
            onWarn,
        });
        expect(xml).toContain('android:pathData="M0 0h8v8z"');
        expect(xml).toContain('android:fillColor="#FF00AA00"');
        expect(onWarn).not.toHaveBeenCalledWith(expect.objectContaining({ code: 'unsupported-element' }));
    });

    it('bakes a sheared <g> transform into path geometry (no <group>)', () => {
        const onWarn = vi.fn();
        // matrix(1,0,0.5,1,0,0): x' = x + 0.5y → (0,10) becomes (5,10)
        const { xml } = convert(svg('<g transform="matrix(1,0,0.5,1,0,0)"><path d="M0 0L0 10" fill="#000"/></g>'), {
            optimize: false,
            onWarn,
        });
        expect(onWarn).toHaveBeenCalledWith(expect.objectContaining({ code: 'group-skew' }));
        expect(xml).not.toContain('<group');
        expect(xml).toMatch(/5[ ,]10/); // skewed endpoint baked into the path
    });

    it('folds opacity into fillAlpha', () => {
        const { xml } = convert(svg('<path d="M0 0z" fill="#000" opacity="0.5"/>'), raw);
        expect(xml).toContain('android:fillAlpha="0.5"');
    });
});

describe('fail-loud on unsupported', () => {
    it('bakes stroke-dasharray into dash geometry instead of warning', () => {
        const { xml, warnings } = convert(svg('<path d="M0 0h10" stroke="#000" stroke-dasharray="4 2"/>'), raw);
        expect(warnings).toEqual([]);
        expect(xml).toContain('android:pathData="M0 0L4 0M6 0L10 0"');
    });

    it('warns on a dash pattern it cannot resolve (font-relative units) and draws the stroke solid', () => {
        const onWarn = vi.fn();
        const { xml } = convert(svg('<path d="M0 0h10" stroke="#000" stroke-dasharray="1em"/>'), {
            optimize: false,
            onWarn,
        });
        expect(onWarn).toHaveBeenCalledWith(expect.objectContaining({ code: 'unsupported-stroke-dasharray' }));
        expect(xml).toContain('android:pathData="M0 0h10"');
    });

    it('warns (non-strict) on a masked path and still draws it', () => {
        const { xml, warnings } = convert(
            svg(
                '<mask id="m"><rect width="5" height="5" fill="#fff"/></mask><path d="M0 0z" fill="#000" mask="url(#m)"/>',
            ),
            raw,
        );
        expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
        expect(xml).toContain('android:pathData="M0 0z"');
    });

    it('does not warn on a <mask>/<pattern> definition that nothing references (never rendered)', () => {
        const { warnings } = convert(
            svg('<mask id="m"><rect width="5" height="5"/></mask><pattern id="p"/><path d="M0 0z"/>'),
            raw,
        );
        expect(warnings).toEqual([]);
    });

    it('throws in strict mode', () => {
        expect(() => convert(svg('<text>hi</text>'), { optimize: false, strict: true })).toThrow();
    });

    it('dashes a stroke whose stroke-dasharray is inherited from a parent <g>', () => {
        const { xml, warnings } = convert(
            svg('<g stroke="#000" stroke-dasharray="5.1"><circle cx="5" cy="5" r="4" fill="none"/></g>'),
            raw,
        );
        expect(warnings).toEqual([]);
        const pathData = /android:pathData="([^"]*)"/.exec(xml)![1]!;
        // Circumference ~25.1 with 5.1 dashes / 5.1 gaps: dashes at 0, 10.2 and 20.4; on a closed
        // subpath the last one runs over the start point and joins the first → 2 sub-paths.
        expect(pathData.match(/M/g)).toHaveLength(2);
    });

    it('does not warn on a dash pattern when nothing is stroked', () => {
        const { warnings } = convert(svg('<g stroke-dasharray="5"><path d="M0 0h1v1z"/></g>'), raw);
        expect(warnings).toEqual([]);
    });

    it.each(['mask', 'filter', 'marker-start', 'marker-mid', 'marker-end'])(
        'warns on a %s reference (silently dropped otherwise)',
        (attr) => {
            const { warnings } = convert(svg(`<path d="M0 0h4v4z" ${attr}="url(#x)"/>`), raw);
            expect(warnings).toContainEqual(expect.objectContaining({ code: 'unsupported-attribute' }));
        },
    );

    it('warns on a mask reference set through a style declaration on a <g>', () => {
        const { warnings } = convert(svg('<g style="mask:url(#m)"><path d="M0 0h4v4z"/></g>'), raw);
        expect(warnings).toContainEqual(expect.objectContaining({ code: 'unsupported-attribute' }));
    });

    it('warns on an objectBoundingBox clipPath (not resolvable)', () => {
        const { warnings } = convert(
            svg(
                '<clipPath id="c" clipPathUnits="objectBoundingBox"><rect width="0.5" height="1"/></clipPath>' +
                    '<path d="M0 0h4v4z" clip-path="url(#c)"/>',
            ),
            raw,
        );
        expect(warnings).toContainEqual(expect.objectContaining({ code: 'unsupported-clip-path' }));
    });

    it('converts the dashed reporter SVG from issue #1 in strict mode (dashes baked)', () => {
        const issueSvg = svg(
            '<defs><ellipse id="o" cx="50" cy="50" rx="46.5" ry="18.3"/></defs>' +
                '<g stroke="#ffb13b" stroke-dasharray="5.1"><use href="#o" fill="none"/></g>',
            'viewBox="-54 -54 208 208"',
        );
        for (const optimize of [true, false]) {
            const { xml } = convert(issueSvg, { optimize, strict: true });
            expect(/android:pathData="([^"]*)"/.exec(xml)![1]!.match(/M/g)!.length).toBeGreaterThan(10);
        }
    });
});

describe('geometry fidelity', () => {
    it('separates compact arc flags in an un-baked path', () => {
        const { xml } = convert(svg('<path d="M2 12a10 10 0 0120 0"/>'), raw);
        expect(xml).toContain('android:pathData="M2 12a10 10 0 0 1 20 0"');
    });

    it('separates compact arc flags in clip-path data', () => {
        const { xml } = convert(
            svg(
                '<clipPath id="c"><path d="M2 12a10 10 0 0120 0"/></clipPath>' +
                    '<path clip-path="url(#c)" d="M0 0h24v24z"/>' +
                    '<g clip-path="url(#c)" transform="translate(1 0)"><path d="M0 0h1v1z"/></g>',
            ),
            raw,
        );
        const clips = xml.match(/<clip-path android:pathData="[^"]*"/g) ?? [];
        expect(clips).toHaveLength(2);
        for (const c of clips) expect(c).toContain('a10 10 0 0 1 20 0');
    });

    it('offsets content by a non-zero viewBox origin', () => {
        const { xml } = convert(svg('<path d="M0 0h1v1z"/>', 'viewBox="-54 -10 208 208"'), raw);
        expect(xml).toContain('android:viewportWidth="208"');
        expect(xml).toMatch(/<group\s+android:translateX="54"\s+android:translateY="10">/);
    });

    it('emits no wrapper group for a zero viewBox origin', () => {
        const { xml } = convert(svg('<path d="M0 0h1v1z"/>'), raw);
        expect(xml).not.toContain('<group');
    });

    it('applies a clip-path set on a <g> to its children', () => {
        const { xml, warnings } = convert(
            svg(
                '<clipPath id="c"><rect width="10" height="10"/></clipPath>' +
                    '<g clip-path="url(#c)"><path d="M0 0h24v24z"/><path d="M1 1h2v2z"/></g>',
            ),
            raw,
        );
        expect(warnings).toEqual([]);
        expect(xml).toMatch(/<group>\s+<clip-path android:pathData="M0,0[^"]*" \/>\s+<path/);
        // both children sit inside the clipped group
        expect(xml.indexOf('</group>')).toBeGreaterThan(xml.indexOf('M1 1h2v2z'));
    });

    it('keeps the clip inside a transformed <g> (clip lives in the group user space)', () => {
        const { xml } = convert(
            svg(
                '<clipPath id="c"><rect width="10" height="10"/></clipPath>' +
                    '<g transform="translate(2 3)" clip-path="url(#c)"><path d="M0 0h1v1z"/></g>',
            ),
            raw,
        );
        expect(xml).toMatch(/android:translateY="3">\s+<clip-path /);
    });

    it('resolves clipPath content made of <use> and transformed children', () => {
        const { xml, warnings } = convert(
            svg(
                '<defs><path id="p" d="M0 0h10v10z"/></defs>' +
                    '<clipPath id="c"><use href="#p" transform="translate(5 0)"/></clipPath>' +
                    '<path d="M0 0h24v24z" clip-path="url(#c)"/>',
            ),
            raw,
        );
        expect(warnings).toEqual([]);
        expect(xml).toMatch(/<clip-path android:pathData="M5[ ,]0/);
    });

    it('applies a transform set directly on a drawable element', () => {
        const { xml } = convert(svg('<path transform="translate(5 6)" d="M0 0h4v4z"/>'), raw);
        expect(xml).toMatch(/android:translateX="5"\s+android:translateY="6">/);
    });

    it('skips elements with display="none"', () => {
        const { xml } = convert(
            svg('<path display="none" d="M9 9h1z"/><g style="display:none"><path d="M8 8h1z"/></g>'),
            raw,
        );
        expect(xml).not.toContain('M9 9h1z');
        expect(xml).not.toContain('M8 8h1z');
    });
});

describe('options parity (xmlTag, tint)', () => {
    it('prepends an XML declaration with xmlTag', () => {
        const { xml } = convert(svg('<path d="M0 0z" fill="#000"/>'), { optimize: false, xmlTag: true });
        expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    });

    it('adds android:tint (Android color, verbatim) to the vector', () => {
        const { xml } = convert(svg('<path d="M0 0z" fill="#000"/>'), { optimize: false, tint: '#80FF0000' });
        expect(xml).toContain('android:tint="#80FF0000"');
    });
});

describe('end-to-end with svgo normalization', () => {
    it('converts shapes+styles via svgo and keeps the gradient', () => {
        const { xml } = convert(
            svg(
                '<style>.a{fill:#0a0}</style><rect class="a" x="0" y="0" width="8" height="8"/>' +
                    '<defs><linearGradient id="g" x1="0" y1="0" x2="24" y2="0" gradientUnits="userSpaceOnUse">' +
                    '<stop stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs>' +
                    '<path d="M0 0h24v24H0z" fill="url(#g)"/>',
            ),
        );
        expect(xml).toContain('<vector');
        expect(xml).toContain('android:type="linear"');
        // the styled rect became a filled path
        expect(xml).toMatch(/android:fillColor="#FF00AA00"/i);
    });
});

describe('rendering fidelity', () => {
    it('skips visibility="hidden" drawables, inherited from a <g>, unless a child overrides it', () => {
        const { xml } = convert(
            svg(
                '<g visibility="hidden"><path d="M1 1h1z"/><path visibility="visible" d="M2 2h1z"/></g>' +
                    '<path style="visibility:collapse" d="M3 3h1z"/>',
            ),
            raw,
        );
        expect(xml).not.toContain('M1 1h1z');
        expect(xml).toContain('M2 2h1z');
        expect(xml).not.toContain('M3 3h1z');
    });

    it('uses the SVG paint fallback color when the url() target is missing', () => {
        const { xml, warnings } = convert(svg('<path d="M0 0h1v1z" fill="url(#nope) #00ff00"/>'), raw);
        expect(xml).toContain('android:fillColor="#FF00FF00"');
        expect(warnings).toEqual([]);
    });

    it('accepts a quoted url() reference', () => {
        const { xml } = convert(
            svg(
                '<linearGradient id="g"><stop stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>' +
                    '<path d="M0 0h10v10z" fill="url(\'#g\')"/>',
            ),
            raw,
        );
        expect(xml).toContain('android:type="linear"');
    });

    it('reports a pattern fill as unsupported paint (not as a missing gradient)', () => {
        const { xml, warnings } = convert(
            svg(
                '<pattern id="p" width="2" height="2"><rect width="1" height="1"/></pattern><path d="M0 0z" fill="url(#p) red"/>',
            ),
            raw,
        );
        expect(warnings.map((w) => w.code)).toEqual(['unsupported-paint']);
        expect(xml).toContain('android:fillColor="#FFFF0000"'); // fallback used
    });

    it('maps opacity on the <svg> root to android:alpha (exact, no folding)', () => {
        const { xml } = convert(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" opacity="0.5"><path d="M0 0h1v1z"/></svg>',
            raw,
        );
        expect(xml).toContain('android:alpha="0.5"');
        expect(xml).not.toContain('android:fillAlpha');
    });

    it('warns when group opacity is folded onto overlapping children', () => {
        const { warnings } = convert(
            svg('<g opacity="0.5"><path d="M0 0h10v10H0z"/><path d="M5 5h10v10H5z"/></g>'),
            raw,
        );
        expect(warnings.map((w) => w.code)).toContain('opacity-approximated');
    });

    it('accounts for stroke width when testing overlap', () => {
        const { warnings } = convert(
            svg('<g opacity="0.5" stroke="#000" stroke-width="4"><path d="M0 0h10"/><path d="M0 3h10"/></g>'),
            raw,
        );
        expect(warnings.map((w) => w.code)).toContain('opacity-approximated');
    });

    it('does not warn when group opacity children are disjoint', () => {
        const { warnings } = convert(
            svg('<g opacity="0.5"><path d="M0 0h4v4H0z"/><path d="M10 10h4v4h-4z"/></g>'),
            raw,
        );
        expect(warnings).toEqual([]);
    });

    it('warns when opacity applies to a path painted with both fill and stroke', () => {
        const { warnings } = convert(svg('<path d="M0 0h4v4H0z" fill="#f00" stroke="#000" opacity="0.5"/>'), raw);
        expect(warnings.map((w) => w.code)).toContain('opacity-approximated');
    });

    it('letterboxes (xMidYMid meet) when width/height and viewBox ratios differ', () => {
        const { xml } = convert(svg('<path d="M0 0h1v1z"/>', 'width="100" height="50" viewBox="0 0 24 24"'), raw);
        expect(xml).toContain('android:viewportWidth="48"');
        expect(xml).toContain('android:viewportHeight="24"');
        expect(xml).toMatch(/<group\s+android:translateX="12">/);
    });

    it('honors preserveAspectRatio alignment and slice', () => {
        const meetMin = convert(
            svg(
                '<path d="M0 0h1v1z"/>',
                'width="100" height="50" viewBox="0 0 24 24" preserveAspectRatio="xMinYMin meet"',
            ),
            raw,
        ).xml;
        expect(meetMin).toContain('android:viewportWidth="48"');
        expect(meetMin).not.toContain('<group');

        const slice = convert(
            svg(
                '<path d="M0 0h1v1z"/>',
                'width="100" height="50" viewBox="0 0 24 24" preserveAspectRatio="xMidYMid slice"',
            ),
            raw,
        ).xml;
        expect(slice).toContain('android:viewportWidth="24"');
        expect(slice).toContain('android:viewportHeight="12"');
        expect(slice).toMatch(/android:translateY="-6">/);
    });

    it('stretches with preserveAspectRatio="none" (VectorDrawable default)', () => {
        const { xml } = convert(
            svg('<path d="M0 0h1v1z"/>', 'width="100" height="50" viewBox="0 0 24 24" preserveAspectRatio="none"'),
            raw,
        );
        expect(xml).toContain('android:viewportWidth="24"');
        expect(xml).not.toContain('<group');
    });

    it('ignores percentage width/height and falls back to the viewBox size', () => {
        const { xml } = convert(svg('<path d="M0 0h1v1z"/>', 'width="100%" height="100%" viewBox="0 0 32 16"'), raw);
        expect(xml).toContain('android:width="32dp"');
        expect(xml).toContain('android:height="16dp"');
    });
});

describe('inherit, <a>, nested <svg>, baked stroke, tint escaping', () => {
    it('treats "inherit" as the parent value for inheritable properties', () => {
        const { xml } = convert(
            svg(
                '<g fill="#ff0000" stroke="#00ff00" stroke-width="3">' +
                    '<path d="M0 0h1v1z" fill="inherit" style="stroke:inherit" stroke-width="inherit"/></g>',
            ),
            raw,
        );
        expect(xml).toContain('android:fillColor="#FFFF0000"');
        expect(xml).toContain('android:strokeColor="#FF00FF00"');
        expect(xml).toContain('android:strokeWidth="3"');
    });

    it('treats <a> exactly like <g> (children drawn, transform kept, no warning)', () => {
        const { xml, warnings } = convert(
            svg('<a href="#x" fill="#ff0000" transform="translate(2,3)"><path d="M0 0h1v1z"/></a>'),
            raw,
        );
        expect(warnings).toEqual([]);
        expect(xml).toContain('android:translateX="2"');
        expect(xml).toContain('android:fillColor="#FFFF0000"');
    });

    it('renders a nested <svg> as a group translated, scaled and clipped to its viewport', () => {
        const { xml, warnings } = convert(
            svg(
                '<svg x="2" y="4" width="10" height="10" viewBox="0 0 20 20" fill="#ff0000">' +
                    '<rect width="20" height="20"/></svg>',
            ),
            raw,
        );
        expect(warnings).toEqual([]);
        expect(xml).toContain('<clip-path android:pathData="M2,4h10v10h-10z" />');
        expect(xml).toContain('android:translateX="2"');
        expect(xml).toContain('android:translateY="4"');
        expect(xml).toContain('android:scaleX="0.5"');
        expect(xml).toContain('android:scaleY="0.5"');
        expect(xml).toContain('android:pathData="M0,0h20v20h-20z"');
        expect(xml).toContain('android:fillColor="#FFFF0000"');
    });

    it('defaults a nested <svg> size to 100% and letterboxes its viewBox (xMidYMid meet)', () => {
        // 24×24 viewport, 12×6 viewBox: scale 2, centered vertically ((24 - 12) / 2 = 6).
        const { xml } = convert(svg('<svg viewBox="0 0 12 6"><path d="M0 0h1v1z"/></svg>'), raw);
        expect(xml).toContain('<clip-path android:pathData="M0,0h24v24h-24z" />');
        expect(xml).toContain('android:translateY="6"');
        expect(xml).toContain('android:scaleX="2"');
        expect(xml).toContain('android:scaleY="2"');
    });

    it('resolves percentages inside a nested <svg> against its own viewport', () => {
        const { xml } = convert(svg('<svg width="12" height="8"><rect width="50%" height="50%"/></svg>'), raw);
        expect(xml).toContain('android:pathData="M0,0h6v4h-6z"');
    });

    it('reports an unsupported attribute on a nested <svg> once', () => {
        const { warnings } = convert(svg('<svg filter="url(#f)"><path d="M0 0h1v1z"/></svg>'), raw);
        expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
    });

    it('scales the stroke width with a transform baked into geometry', () => {
        const { xml } = convert(
            svg('<g transform="skewX(20) scale(3)"><path d="M0 0h1" fill="none" stroke="#000" stroke-width="2"/></g>'),
            raw,
        );
        expect(xml).toContain('android:strokeWidth="6"');
    });

    it('escapes the tint option in the XML attribute', () => {
        const { xml } = convert(svg('<path d="M0 0z"/>'), { optimize: false, tint: '"/><x a="' });
        expect(xml).toContain('android:tint="&quot;/&gt;&lt;x a=&quot;"');
        expect(xml).not.toContain('<x a=');
    });
});

describe('severity rules', () => {
    // A dash pattern in font-relative units cannot be resolved, so it still warns.
    const dashed = svg('<path d="M0 0h10" stroke="#000" stroke-dasharray="1em"/>');

    it('throws a ConversionError carrying the warning when a rule is "error"', () => {
        try {
            convert(dashed, { optimize: false, rules: { 'unsupported-stroke-dasharray': 'error' } });
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(ConversionError);
            expect((err as ConversionError).warning.code).toBe('unsupported-stroke-dasharray');
            expect((err as Error).message).toMatch(/^\[unsupported-stroke-dasharray\]/);
        }
    });

    it('lets a rule downgrade a code to "warn" under strict', () => {
        const { warnings } = convert(dashed, {
            optimize: false,
            strict: true,
            rules: { 'unsupported-stroke-dasharray': 'warn' },
        });
        expect(warnings.map((w) => w.code)).toEqual(['unsupported-stroke-dasharray']);
    });

    it('silences a code with "off" (neither returned nor passed to onWarn)', () => {
        const onWarn = vi.fn();
        const { warnings } = convert(dashed, {
            optimize: false,
            strict: true,
            onWarn,
            rules: { 'unsupported-stroke-dasharray': 'off' },
        });
        expect(warnings).toEqual([]);
        expect(onWarn).not.toHaveBeenCalled();
    });
});

describe('severity rules validation', () => {
    it('rejects an unknown code in rules (typo protection)', () => {
        expect(() => convert(svg('<path d="M0 0z"/>'), { rules: { 'opacty-approximated': 'off' } as never })).toThrow(
            TypeError,
        );
    });
});

describe('units & percentages', () => {
    it('parses opacity, fill-opacity and stroke-opacity given as percentages', () => {
        expect(convert(svg('<path d="M0 0h1v1z" opacity="50%"/>'), raw).xml).toContain('android:fillAlpha="0.5"');
        const { xml } = convert(
            svg('<path d="M0 0h1v1z" fill-opacity="25%" stroke="#000" stroke-opacity="50%"/>'),
            raw,
        );
        expect(xml).toContain('android:fillAlpha="0.25"');
        expect(xml).toContain('android:strokeAlpha="0.5"');
    });

    it('maps opacity="50%" on the root to android:alpha', () => {
        expect(convert(svg('<path d="M0 0h1v1z"/>', 'viewBox="0 0 24 24" opacity="50%"'), raw).xml).toContain(
            'android:alpha="0.5"',
        );
    });

    it('converts absolute units on the root width/height (96 px per inch)', () => {
        const { xml } = convert(svg('<path d="M0 0h1v1z"/>', 'viewBox="0 0 24 24" width="2in" height="72pt"'), raw);
        expect(xml).toContain('android:width="192dp"');
        expect(xml).toContain('android:height="96dp"');
    });

    it('falls back to the viewBox size for font-relative root width/height', () => {
        const { xml } = convert(svg('<path d="M0 0h1v1z"/>', 'viewBox="0 0 24 24" width="2em" height="3ex"'), raw);
        expect(xml).toContain('android:width="24dp"');
        expect(xml).toContain('android:height="24dp"');
    });

    it('resolves a percentage stroke-width against the normalized viewport diagonal', () => {
        // sqrt((30² + 40²) / 2) = 35.355…; 10% of it = 3.536
        const { xml } = convert(
            svg('<path d="M0 0h1v1z" fill="none" stroke="#000" stroke-width="10%"/>', 'viewBox="0 0 30 40"'),
            raw,
        );
        expect(xml).toContain('android:strokeWidth="3.536"');
    });

    it('resolves percentage shape attributes against the viewport', () => {
        const vb = 'viewBox="0 0 20 40"';
        expect(convert(svg('<rect x="10%" y="10%" width="50%" height="50%"/>', vb), raw).xml).toContain(
            'android:pathData="M2,4h10v20h-10z"',
        );
        expect(convert(svg('<ellipse cx="50%" cy="50%" rx="25%" ry="25%"/>', vb), raw).xml).toContain(
            'android:pathData="M5,20a5,10 0 1 0 10,0a5,10 0 1 0 -10,0z"',
        );
        expect(convert(svg('<line x1="0" y1="0" x2="100%" y2="50%" stroke="#000"/>', vb), raw).xml).toContain(
            'android:pathData="M0,0L20,20"',
        );
        // r is relative to the normalized diagonal: sqrt((30² + 40²) / 2) · 10% = 3.536
        expect(convert(svg('<circle cx="50%" cy="50%" r="10%"/>', 'viewBox="0 0 30 40"'), raw).xml).toContain(
            'android:pathData="M11.464,20a3.536,3.536 0 1 0 7.071,0a3.536,3.536 0 1 0 -7.071,0z"',
        );
    });

    it('formats generated shape numbers without float noise', () => {
        const { xml } = convert(svg('<rect width="1.1" height="1" rx="0.3"/>'), raw);
        expect(xml).toContain('android:pathData="M0.3,0h0.5a0.3,0.3 0 0 1 0.3,0.3');
        expect(xml).not.toMatch(/\d\.\d{7,}/);
    });
});

describe('unapplied CSS, ignored stroke attributes, duplicate warnings', () => {
    const codes = (s: string, opts = raw): string[] => convert(s, opts).warnings.map((w) => w.code);

    it('warns once on a non-empty <style> left as-is (optimize:false)', () => {
        const doc = svg(
            '<style>.a{fill:red}</style><path class="a" d="M0 0h4v4H0z"/><path class="a" d="M5 0h4v4H5z"/>',
        );
        expect(codes(doc)).toEqual(['unsupported-style']);
    });

    it('warns on CSS that svgo could not inline (@media, pseudo-classes)', () => {
        const media = svg('<style>@media (max-width: 100px){.a{fill:white}}</style><path class="a" d="M0 0h4v4H0z"/>');
        expect(codes(media, { optimize: true })).toEqual(['unsupported-style']);
        const hover = svg('<style>.a:hover{fill:blue}</style><path class="a" d="M0 0h4v4H0z"/>');
        expect(codes(hover, { optimize: true })).toEqual(['unsupported-style']);
    });

    it('does not warn on an empty <style>, a comment-only one, or fully inlined rules', () => {
        expect(codes(svg('<style></style><path d="M0 0h4v4H0z"/>'))).toEqual([]);
        expect(codes(svg('<style> /* nothing */ </style><path d="M0 0h4v4H0z"/>'))).toEqual([]);
        const inlined = svg('<style>.a{fill:red}</style><path class="a" d="M0 0h4v4H0z"/>');
        expect(codes(inlined, { optimize: true })).toEqual([]);
    });

    it('warns on vector-effect other than none (not inherited)', () => {
        const stroked = 'fill="none" stroke="#000"';
        expect(codes(svg(`<path d="M0 0h4" ${stroked} vector-effect="non-scaling-stroke"/>`))).toEqual([
            'unsupported-attribute',
        ]);
        expect(codes(svg(`<path d="M0 0h4" ${stroked} style="vector-effect:non-scaling-stroke"/>`))).toEqual([
            'unsupported-attribute',
        ]);
        expect(codes(svg(`<path d="M0 0h4" ${stroked} vector-effect="none"/>`))).toEqual([]);
        expect(codes(svg(`<g vector-effect="non-scaling-stroke"><path d="M0 0h4" ${stroked}/></g>`))).toEqual([]);
    });

    it('warns on a paint-order that paints the stroke below the fill (inherited)', () => {
        const both = 'fill="#f00" stroke="#000"';
        expect(codes(svg(`<path d="M0 0h4v4H0z" ${both} paint-order="stroke"/>`))).toEqual(['unsupported-attribute']);
        expect(codes(svg(`<g paint-order="stroke fill"><path d="M0 0h4v4H0z" ${both}/></g>`))).toEqual([
            'unsupported-attribute',
        ]);
        for (const order of ['normal', 'fill', 'fill stroke', 'fill stroke markers', 'markers'])
            expect(codes(svg(`<path d="M0 0h4v4H0z" ${both} paint-order="${order}"/>`))).toEqual([]);
        // Nothing to reorder when only one of fill / stroke is painted.
        expect(codes(svg('<path d="M0 0h4" fill="none" stroke="#000" paint-order="stroke"/>'))).toEqual([]);
    });

    it('warns on stroke-linejoin="arcs" / "miter-clip" on a stroked path (inherited)', () => {
        const stroked = 'fill="none" stroke="#000"';
        expect(codes(svg(`<path d="M0 0h4v4" ${stroked} stroke-linejoin="arcs"/>`))).toEqual(['unsupported-attribute']);
        expect(codes(svg(`<g style="stroke-linejoin:miter-clip"><path d="M0 0h4v4" ${stroked}/></g>`))).toEqual([
            'unsupported-attribute',
        ]);
        expect(codes(svg('<path d="M0 0h4v4" stroke-linejoin="arcs"/>'))).toEqual([]);
    });

    it('reports an unsupported attribute on a transformed element once', () => {
        expect(codes(svg('<path d="M0 0h4v4H0z" transform="translate(1 2)" mask="url(#m)"/>'))).toEqual([
            'unsupported-attribute',
        ]);
        expect(codes(svg('<rect width="4" height="4" transform="rotate(10)" style="filter:url(#f)"/>'))).toEqual([
            'unsupported-attribute',
        ]);
    });

    it('reports a style-declared unsupported attribute on a nested <svg> once', () => {
        expect(codes(svg('<svg style="filter:url(#f)"><path d="M0 0h1v1z"/></svg>'))).toEqual([
            'unsupported-attribute',
        ]);
        expect(codes(svg('<svg transform="translate(1 1)" mask="url(#m)"><path d="M0 0h1v1z"/></svg>'))).toEqual([
            'unsupported-attribute',
        ]);
    });

    it('detects overlapping drawables inside a nested <svg> under group opacity', () => {
        // The nested viewBox scales its content ×4: the two 2×2 squares (4 units apart) overlap once mapped.
        const doc = svg(
            '<g opacity="0.5"><svg width="24" height="24" viewBox="0 0 6 6">' +
                '<rect width="2" height="2"/></svg><rect x="4" y="4" width="8" height="8"/></g>',
        );
        expect(codes(doc)).toEqual(['opacity-approximated']);
    });

    it('clips nested <svg> drawables to their viewport before testing overlap', () => {
        // The rect overflows the 4×4 nested viewport; clipped, it does not reach the second rect.
        const doc = svg(
            '<g opacity="0.5"><svg width="4" height="4"><rect width="20" height="20"/></svg>' +
                '<rect x="10" y="10" width="4" height="4"/></g>',
        );
        expect(codes(doc)).toEqual([]);
        expect(codes(doc.replace('<svg width="4"', '<svg overflow="visible" width="4"'))).toEqual([
            'opacity-approximated',
        ]);
    });
});

describe('elliptical radial fill rendered exactly in a transformed group', () => {
    const stops = '<stop stop-color="#f00"/><stop offset="0.6" stop-color="#ff0"/><stop offset="1" stop-color="#00f"/>';
    /** A userSpaceOnUse unit-circle radial (Figma style) under `transform`. */
    const figma = (transform: string, extra = ''): string =>
        `<radialGradient id="r" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="${transform}"${extra}>${stops}</radialGradient>`;
    const full = 'M0 0h24v24H0z';

    /** Converts, then asserts the output renders like the source (resvg, 1 % threshold) for both optimize modes. */
    function expectExact(doc: string, expectedCodes: string[] = []): string {
        let first = '';
        for (const optimize of [false, true]) {
            const { xml, warnings } = convert(doc, { optimize });
            first ||= xml;
            expect(warnings.map((w) => w.code)).toEqual(expectedCodes);
            expect(xml).toMatch(/<group[^>]*android:scaleY/);
            const result = compareSvgs(doc, vdToSvg(xml));
            expect(result.inked).toBeGreaterThan(0);
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        }
        return first;
    }

    it('Figma-like translate(12 12) scale(10 4)', () => {
        const xml = expectExact(
            svg(`<defs>${figma('translate(12 12) scale(10 4)')}</defs><path d="${full}" fill="url(#r)"/>`),
        );
        expect(xml).toContain('android:scaleY="0.4"');
        expect(xml).toContain('android:gradientRadius="10"');
        expect(xml).not.toContain('android:scaleX');
    });

    it('objectBoundingBox on a 24×6 rect', () => {
        expectExact(
            svg(
                `<defs><radialGradient id="r">${stops}</radialGradient></defs><rect y="9" width="24" height="6" fill="url(#r)"/>`,
            ),
        );
    });

    it('a skewed gradientTransform', () => {
        expectExact(
            svg(`<defs>${figma('translate(12 12) skewX(30) scale(8)')}</defs><path d="${full}" fill="url(#r)"/>`),
        );
    });

    it('rotated + non-uniform, with spreadMethod reflect', () => {
        const doc = svg(
            `<defs>${figma('translate(12 12) rotate(30) scale(6 2)', ' spreadMethod="reflect"')}</defs><path d="${full}" fill="url(#r)"/>`,
        );
        expect(expectExact(doc)).toContain('android:tileMode="mirror"');
    });

    it('under a parent <g transform> (Android group)', () => {
        expectExact(
            svg(
                `<defs>${figma('translate(12 12) scale(10 4)')}</defs><g transform="translate(2 3) rotate(15) scale(0.8)"><path d="${full}" fill="url(#r)"/></g>`,
            ),
        );
    });

    it('under a skewed parent (baked transform): exact, no gradient-under-skew', () => {
        expectExact(
            svg(
                `<defs>${figma('translate(12 12) scale(10 4)')}</defs><g transform="skewX(20)"><path d="M-4 0h24v24H-4z" fill="url(#r)"/></g>`,
            ),
            ['group-skew'],
        );
    });

    it('a uniform radial under a skewed parent becomes exact too', () => {
        expectExact(
            svg(
                `<defs><radialGradient id="r" cx="12" cy="12" r="9" gradientUnits="userSpaceOnUse">${stops}</radialGradient></defs>` +
                    `<g transform="skewX(25)"><path d="M-6 0h24v24H-6z" fill="url(#r)"/></g>`,
            ),
            ['group-skew'],
        );
    });

    it('with a clip-path on the element (the clip stays in user space, outside the group)', () => {
        const xml = expectExact(
            svg(
                `<defs>${figma('translate(12 12) rotate(30) scale(10 4)')}<clipPath id="c"><circle cx="12" cy="12" r="9"/></clipPath></defs>` +
                    `<path d="${full}" fill="url(#r)" clip-path="url(#c)"/>`,
            ),
        );
        // clip-path first, then the transformed group: the clip is not distorted by the gradient matrix
        expect(xml.indexOf('<clip-path')).toBeLessThan(xml.lastIndexOf('<group'));
    });

    it('with fill-opacity and evenodd', () => {
        const xml = expectExact(
            svg(
                `<defs>${figma('translate(12 12) scale(10 4)')}</defs>` +
                    '<path d="M2 2h20v20H2zM7 7h10v10H7z" fill="url(#r)" fill-opacity="0.5" fill-rule="evenodd"/>',
            ),
        );
        expect(xml).toContain('android:fillAlpha="0.5"');
        expect(xml).toContain('android:fillType="evenOdd"');
    });

    it('with a dashed stroke: the fill path is exact, the stroke stays in user space', () => {
        const doc = svg(
            `<defs>${figma('translate(12 12) scale(10 4)')}</defs>` +
                `<path d="M3 3h18v18H3z" fill="url(#r)" stroke="#000" stroke-width="1.5" stroke-dasharray="3 2"/>`,
        );
        const xml = expectExact(doc);
        // the stroke path is outside the group
        expect(xml.indexOf('android:strokeColor')).toBeGreaterThan(xml.indexOf('</group>'));
    });

    it('with a dashed stroke painted first (paint-order)', () => {
        const doc = svg(
            `<defs>${figma('translate(12 12) scale(10 4)')}</defs>` +
                `<path d="M3 3h18v18H3z" fill="url(#r)" stroke="#000" stroke-width="3" stroke-dasharray="3 2" paint-order="stroke"/>`,
        );
        const xml = expectExact(doc);
        expect(xml.indexOf('android:strokeColor')).toBeLessThan(xml.indexOf('<group'));
    });

    it('keeps the approximation (and the warning) when a solid stroke shares the path', () => {
        const doc = svg(
            `<defs>${figma('translate(12 12) scale(10 4)')}</defs><path d="M3 3h18v18H3z" fill="url(#r)" stroke="#000"/>`,
        );
        const { xml, warnings } = convert(doc, raw);
        expect(warnings.map((w) => w.code)).toEqual(['gradient-approximated']);
        expect(xml).not.toContain('<group');
        expect(xml).toContain('android:gradientRadius="6.325"');
    });

    it('keeps the focal point approximated (warning) while rendering the ellipse exactly', () => {
        const doc = svg(
            `<defs><radialGradient id="r" cx="0" cy="0" r="1" fx="0.3" gradientUnits="userSpaceOnUse" gradientTransform="translate(12 12) scale(10 4)">${stops}</radialGradient></defs>` +
                `<path d="${full}" fill="url(#r)"/>`,
        );
        const { xml, warnings } = convert(doc, raw);
        expect(warnings.map((w) => w.code)).toEqual(['gradient-approximated']);
        expect(warnings[0]!.message).toContain('focal');
        expect(xml).toContain('android:scaleY="0.4"');
    });

    it('keeps the fallback for a singular gradientTransform', () => {
        const doc = svg(`<defs>${figma('translate(12 12) scale(10 0)')}</defs><path d="${full}" fill="url(#r)"/>`);
        const { xml, warnings } = convert(doc, raw);
        expect(warnings.map((w) => w.code)).toEqual(['gradient-approximated']);
        expect(xml).not.toContain('<group');
    });

    it('leaves a uniform radial unchanged (no group)', () => {
        const doc = svg(
            `<defs>${figma('translate(12 12) rotate(20) scale(10)')}</defs><path d="${full}" fill="url(#r)"/>`,
        );
        const { xml, warnings } = convert(doc, raw);
        expect(warnings).toEqual([]);
        expect(xml).not.toContain('<group');
    });
});

describe('clip-equivalent masks', () => {
    const clipCount = (xml: string): number => (xml.match(/<clip-path /g) ?? []).length;

    /** Converts with and without svgo: only `codes` warnings, `clips` clip-paths, renders like the source. */
    function expectClipped(doc: string, clips = 1, codes: string[] = []): string {
        let first = '';
        for (const optimize of [false, true]) {
            const { xml, warnings } = convert(doc, { optimize });
            first ||= xml;
            expect(warnings.map((w) => w.code)).toEqual(codes);
            expect(clipCount(xml)).toBe(clips);
            if (!codes.length) expect(() => convert(doc, { optimize, strict: true })).not.toThrow();
            const result = compareSvgs(doc, vdToSvg(xml));
            expect(result.inked).toBeGreaterThan(0);
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        }
        return first;
    }

    /** Keeps the mask unsupported: one warning naming `reason`, element drawn unmasked, no clip. */
    function expectRejected(doc: string, reason: RegExp): void {
        for (const optimize of [false, true]) {
            const { xml, warnings } = convert(doc, { optimize });
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
            expect(warnings[0]!.message).toMatch(/^mask on </);
            expect(warnings[0]!.message).toMatch(reason);
            expect(xml).not.toContain('<clip-path');
            expect(xml).toContain('<path');
        }
    }

    const square = '<path d="M0 0h24v24H0z" fill="#f00" mask="url(#m)"/>';

    it('turns a white rect mask on a path into a <clip-path>', () => {
        const xml = expectClipped(
            svg(`<mask id="m"><rect x="4" y="4" width="10" height="10" fill="#fff"/></mask>${square}`),
        );
        expect(xml).not.toContain('mask');
    });

    it.each([
        'white',
        '#ffffff',
        '#FFFF',
        'rgb(255,255,255)',
        'rgb(100%,100%,100%)',
        'hsl(0,0%,100%)',
        'rgba(255,255,255,1)',
    ])('accepts the white spelling %s', (white) => {
        expectClipped(svg(`<mask id="m"><rect x="4" y="4" width="10" height="10" fill="${white}"/></mask>${square}`));
    });

    it('inherits the white fill from the <mask> element and its ancestors', () => {
        expectClipped(svg(`<defs fill="#fff"><mask id="m"><circle cx="12" cy="12" r="8"/></mask></defs>${square}`));
        expectClipped(svg(`<mask id="m" style="fill:white"><circle cx="12" cy="12" r="8"/></mask>${square}`));
    });

    it('ignores mask content that paints nothing (fill none, display none, hidden, empty)', () => {
        expectClipped(
            svg(
                '<mask id="m"><rect x="4" y="4" width="10" height="10" fill="#fff"/>' +
                    '<rect width="24" height="24" fill="none"/><rect width="24" height="24" fill="#888" display="none"/>' +
                    `<rect width="24" height="24" fill="#888" visibility="hidden"/><rect width="0" height="5"/></mask>${square}`,
            ),
        );
    });

    it('clips a <g> with a white mask', () => {
        expectClipped(
            svg(
                '<mask id="m"><circle cx="12" cy="12" r="8" fill="#fff"/></mask>' +
                    '<g mask="url(#m)" fill="#00f"><circle cx="8" cy="8" r="6"/><rect x="10" y="10" width="12" height="12" fill="#0a0"/></g>',
            ),
        );
    });

    it('flattens mask content with transforms and <use>, under a transformed element', () => {
        expectClipped(
            svg(
                '<defs><rect id="r" width="8" height="8"/></defs>' +
                    '<mask id="m"><g transform="translate(2 2)" fill="#fff"><use href="#r"/>' +
                    '<use href="#r" x="10" y="10" transform="rotate(10 14 14)"/></g></mask>' +
                    '<path transform="translate(1 1) scale(0.9)" d="M0 0h24v24H0z" fill="#f00" mask="url(#m)"/>',
            ),
        );
    });

    it('clips a sheared group (transform baked) with its mask', () => {
        expectClipped(
            svg(
                '<mask id="m"><rect x="2" y="2" width="10" height="16" fill="#fff"/></mask>' +
                    '<g transform="skewX(15)" mask="url(#m)"><path d="M0 0h20v20H0z" fill="#f0f"/></g>',
            ),
            1,
            ['group-skew'],
        );
    });

    it('applies both clips to an element with a clip-path and a mask', () => {
        const xml = expectClipped(
            svg(
                '<clipPath id="c"><rect width="12" height="24"/></clipPath>' +
                    '<mask id="m"><rect width="24" height="12" fill="#fff"/></mask>' +
                    '<path d="M0 0h24v24H0z" fill="#f00" clip-path="url(#c)" mask="url(#m)"/>',
            ),
            2,
        );
        expect(xml).toMatch(/<clip-path[^]*<group>\s+<clip-path/);
    });

    it('treats an alpha mask with an opaque non-white fill (Figma export) as a clip', () => {
        expectClipped(
            svg(
                '<mask id="m" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">' +
                    '<circle cx="12" cy="12" r="9" fill="#D9D9D9"/></mask>' +
                    '<g mask="url(#m)"><path d="M0 0h24v24H0z" fill="#123456"/></g>',
            ),
        );
    });

    it('intersects the mask region when it cuts the mask content', () => {
        expectClipped(
            svg(
                '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="12" height="24">' +
                    `<rect width="24" height="24" fill="#fff"/></mask>${square}`,
            ),
            2,
        );
        // Default region (objectBoundingBox, -10 % / 120 %) of a small element cuts a large content.
        expectClipped(
            svg(
                '<mask id="m"><rect width="24" height="24" fill="#fff"/></mask><rect x="6" y="6" width="10" height="10" rx="2" fill="#0a0" mask="url(#m)"/>',
            ),
            2,
        );
    });

    it('supports maskContentUnits="objectBoundingBox" (content scaled to the element bbox)', () => {
        expectClipped(
            svg(
                '<mask id="m" maskContentUnits="objectBoundingBox"><rect width="0.5" height="0.5" fill="#fff"/>' +
                    '<circle cx="0.75" cy="0.75" r="0.2" fill="#fff"/></mask>' +
                    '<rect x="4" y="2" width="16" height="20" fill="#f80" mask="url(#m)"/>',
            ),
        );
    });

    it('converts one shared mask for several elements', () => {
        expectClipped(
            svg(
                '<mask id="m" maskUnits="userSpaceOnUse"><rect x="4" y="4" width="16" height="16" fill="#fff"/></mask>' +
                    '<path d="M0 0h12v12H0z" fill="#f00" mask="url(#m)"/><path d="M12 12h12v12H12z" fill="#00f" mask="url(#m)"/>',
            ),
            2,
        );
    });

    it.each([
        ['a gray fill', '<rect width="10" height="10" fill="#808080"/>', /not white/],
        ['the default black fill', '<rect width="10" height="10"/>', /not white/],
        ['a semi-transparent white', '<rect width="10" height="10" fill="#fff" fill-opacity="0.5"/>', /translucent/],
        ['an rgba white', '<rect width="10" height="10" fill="rgba(255,255,255,0.5)"/>', /translucent/],
        ['a group opacity', '<g opacity="0.5"><rect width="10" height="10" fill="#fff"/></g>', /translucent/],
        ['a stroke', '<rect width="10" height="10" fill="#fff" stroke="#fff"/>', /stroke/],
        [
            'a gradient fill',
            '<linearGradient id="g"><stop stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><rect width="10" height="10" fill="url(#g)"/>',
            /gradient|pattern/,
        ],
        ['an evenodd fill rule', '<path d="M0 0h10v10H0zM2 2h6v6H2z" fill="#fff" fill-rule="evenodd"/>', /evenodd/],
        ['a filter inside', '<rect width="10" height="10" fill="#fff" filter="url(#f)"/>', /filter/],
        ['text inside', '<rect width="10" height="10" fill="#fff"/><text>x</text>', /<text>/],
        ['currentColor (unknown root color)', '<rect width="10" height="10" fill="currentColor"/>', /solid color/],
    ])('keeps the warning for a mask with %s', (_, content, reason) => {
        expectRejected(svg(`<mask id="m">${content}</mask>${square}`), reason);
    });

    it('keeps the warning for an alpha mask with translucent content', () => {
        expectRejected(
            svg(
                `<mask id="m" mask-type="alpha"><rect width="10" height="10" fill="#000" opacity="0.4"/></mask>${square}`,
            ),
            /translucent/,
        );
    });

    it('keeps the warning for an unknown mask and an empty mask', () => {
        expectRejected(svg(`<path d="M0 0h24v24H0z" fill="#f00" mask="url(#nope)"/>`), /unknown mask/);
        expectRejected(svg(`<mask id="m"><rect width="0" height="5" fill="#fff"/></mask>${square}`), /empty/);
    });

    it('still throws in strict mode for a mask that is not clip-equivalent', () => {
        const doc = svg(`<mask id="m"><rect width="10" height="10" fill="#808080"/></mask>${square}`);
        expect(() => convert(doc, { optimize: false, strict: true })).toThrow(ConversionError);
    });
});

describe('evenodd clip paths (rewritten to an equivalent nonzero geometry)', () => {
    const doc = (inner: string): string => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${inner}</svg>`;
    // A ring: both contours drawn in the same direction, so nonzero alone would fill the hole.
    const ring = 'M2 2h20v20H2zM8 8h8v8H8z';
    const fill = '<path d="M0 0h24v24H0z" fill="#3f51b5"';

    const cases: Record<string, string> = {
        'clip-rule on the clip child': `<clipPath id="c"><path d="${ring}" clip-rule="evenodd"/></clipPath>${fill} clip-path="url(#c)"/>`,
        'clip-rule inherited from the <clipPath>': `<clipPath id="c" clip-rule="evenodd"><path d="${ring}"/></clipPath>${fill} clip-path="url(#c)"/>`,
        'clip on a <g>': `<clipPath id="c"><path d="${ring}" clip-rule="evenodd"/></clipPath><g clip-path="url(#c)">${fill}/></g>`,
        'transformed clipPath': `<clipPath id="c" transform="rotate(20 12 12)"><path d="${ring}" clip-rule="evenodd"/></clipPath>${fill} clip-path="url(#c)"/>`,
        'target with three nested levels': `<clipPath id="c"><path d="M1 1h22v22H1zM5 5h14v14H5zM9 9h6v6H9z" clip-rule="evenodd"/></clipPath>${fill} clip-path="url(#c)"/>`,
        'evenodd child next to a nonzero child': `<clipPath id="c"><path d="M1 1h10v10H1zM4 4h4v4H4z" clip-rule="evenodd"/><rect x="13" y="13" width="9" height="9"/></clipPath>${fill} clip-path="url(#c)"/>`,
    };

    for (const [name, inner] of Object.entries(cases)) {
        it(`renders like its source without warning: ${name}`, () => {
            for (const optimize of [true, false]) {
                const { xml, warnings } = convert(doc(inner), { optimize });
                expect(warnings).toEqual([]);
                expect(compareSvgs(doc(inner), vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            }
        });
    }

    it('keeps the warning when evenodd contours cross (no nonzero equivalent by orientation)', () => {
        const crossing = `<clipPath id="c"><path d="M2 2h12v12H2zM8 8h12v12H8z" clip-rule="evenodd"/></clipPath>${fill} clip-path="url(#c)"/>`;
        const { warnings } = convert(doc(crossing), raw);
        expect(warnings).toContainEqual(expect.objectContaining({ code: 'unsupported-clip-path' }));
    });
});
