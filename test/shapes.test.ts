import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { convert } from '../src/index.js';
import { shapeToPathData } from '../src/shapes.js';
import { vdToSvg } from './visual/vdToSvg.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';

/** Path data of a 100×80 rect at the origin with the given extra attributes. */
const rect = (attrs: Record<string, string>, viewport?: { width: number; height: number }) =>
    shapeToPathData('rect', { width: '100', height: '80', ...attrs }, { viewport });

describe('rect corner radii (SVG 2 used values)', () => {
    it('mirrors a negative rx from ry (negative = error → auto)', () => {
        expect(rect({ rx: '-30', ry: '20' })).toBe(rect({ rx: '20', ry: '20' }));
    });

    it('mirrors a negative ry from rx', () => {
        expect(rect({ rx: '20', ry: '-30' })).toBe(rect({ rx: '20', ry: '20' }));
    });

    it('gives square corners when both radii are negative', () => {
        expect(rect({ rx: '-30', ry: '-40' })).toBe('M0,0h100v80h-100z');
    });

    it('treats `auto` and unparsable radii like a missing one', () => {
        expect(rect({ rx: 'auto', ry: '20' })).toBe(rect({ ry: '20' }));
        expect(rect({ rx: '20', ry: 'bogus' })).toBe(rect({ rx: '20' }));
        expect(rect({ rx: 'auto', ry: 'auto' })).toBe('M0,0h100v80h-100z');
    });

    it('mirrors before clamping each radius to half its side', () => {
        // ry auto → 60, then rx ≤ 50 and ry ≤ 40.
        expect(rect({ rx: '60', ry: '-1' })).toBe(rect({ rx: '50', ry: '40' }));
    });

    it('mirrors the absolute value of a percentage radius', () => {
        // rx = 10 % of the 200-wide viewport = 20; ry (auto) takes 20, not 10 % of the height.
        expect(rect({ rx: '10%', ry: '-5' }, { width: 200, height: 100 })).toBe(rect({ rx: '20', ry: '20' }));
    });

    it('keeps an explicit zero radius (not auto)', () => {
        expect(rect({ rx: '0', ry: '-5' })).toBe('M0,0h100v80h-100z');
    });
});

describe('ellipse radii (SVG 2: a missing or invalid radius is auto)', () => {
    const ellipse = (attrs: Record<string, string>) =>
        shapeToPathData('ellipse', { cx: '12', cy: '12', ...attrs }, { viewport: { width: 24, height: 24 } });
    const circle = 'M7,12a5,5 0 1 0 10,0a5,5 0 1 0 -10,0z';

    it('takes the other radius when one is missing, auto, negative, unparsable or empty', () => {
        for (const ry of [undefined, 'auto', '-3', 'bogus', '', ' ']) {
            expect(ellipse(ry === undefined ? { rx: '5' } : { rx: '5', ry }), `ry=${ry}`).toBe(circle);
            expect(ellipse(ry === undefined ? { ry: '5' } : { ry: '5', rx: ry }), `rx=${ry}`).toBe(circle);
        }
    });

    it('mirrors the absolute value of a percentage radius', () => {
        // rx = 25 % of the 24-wide viewport = 6; ry (auto) takes 6.
        expect(ellipse({ rx: '25%', ry: '-1' })).toBe(ellipse({ rx: '6', ry: '6' }));
    });

    it('draws nothing when both radii are auto, or for an explicit zero radius', () => {
        expect(ellipse({})).toBeNull();
        expect(ellipse({ rx: '-5', ry: 'auto' })).toBeNull();
        expect(ellipse({ rx: '5', ry: '0' })).toBeNull();
    });

    const svgOf = (shape: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${shape}</svg>`;
    for (const optimize of [true, false]) {
        it(`draws a circle of radius rx for <ellipse rx="5"> and ry="-3" (optimize: ${optimize})`, () => {
            for (const shape of [
                '<ellipse cx="12" cy="12" rx="5"/>',
                '<ellipse cx="12" cy="12" rx="5" ry="-3"/>',
                '<ellipse cx="12" cy="12" rx="5" ry=""/>',
            ]) {
                const { xml, warnings } = convert(svgOf(shape), { optimize, strict: true });
                expect(warnings, shape).toEqual([]);
                expect(xml, shape).toContain(`android:pathData="${circle}"`);
            }
            // An empty value counts as absent (svgo drops it); an unparsable one is reported.
            const { xml, warnings } = convert(svgOf("<ellipse cx='12' cy='12' ry='5' rx='bogus'/>"), { optimize });
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
            expect(xml).toContain(`android:pathData="${circle}"`);
        });
    }
});

describe('wpt-rect-negative-radius.svg renders like its source', () => {
    const file = fileURLToPath(new URL('wpt-repro/wpt-rect-negative-radius.svg', import.meta.url));
    const svg = readFileSync(file, 'utf8');

    for (const optimize of [true, false]) {
        it(`optimize: ${optimize}`, () => {
            const { xml, warnings } = convert(svg, { optimize, strict: true });
            expect(warnings.map((w) => w.code)).toEqual(['large-vector']);
            const result = compareSvgs(svg, vdToSvg(xml));
            expect(result.sizeMismatch).toBeNull();
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        });
    }
});

describe('geometry properties in CSS (SVG 2: the declaration wins over the attribute)', () => {
    const circle = (attrs: Record<string, string>, viewport?: { width: number; height: number }) =>
        shapeToPathData('circle', { cx: '50', cy: '50', r: '5', ...attrs }, { viewport });
    const ellipse = (attrs: Record<string, string>) =>
        shapeToPathData('ellipse', { cx: '5', cy: '5', rx: '2', ry: '3', ...attrs });
    const square = (attrs: Record<string, string>, viewport?: { width: number; height: number }) =>
        shapeToPathData('rect', { width: '10', height: '10', ...attrs }, { viewport });

    // Expected values: Chrome's getBBox() on the same markup.
    it('reads r, cx and cy from style, with or without unit', () => {
        expect(circle({ style: 'r:0' })).toBeNull();
        expect(circle({ style: 'r:10px' })).toBe(circle({ r: '10' }));
        expect(circle({ style: 'r:10' })).toBe(circle({ r: '10' }));
        expect(circle({ style: 'R: 10PX' })).toBe(circle({ r: '10' }));
        expect(circle({ style: 'cx:1em;cy:20px' })).toBe(circle({ cx: '16', cy: '20' }));
    });

    it('resolves a percentage on the viewport (r: normalized diagonal)', () => {
        const viewport = { width: 200, height: 100 };
        expect(circle({ style: 'r:10%' }, viewport)).toBe(circle({ r: '10%' }, viewport));
        expect(square({ style: 'x:5px;y:50%;width:50%' }, viewport)).toBe('M5,50h100v10h-100z');
    });

    it('reads x, y, width and height from style; width / height auto is 0', () => {
        expect(square({ style: 'height:0' })).toBeNull();
        expect(square({ style: 'width:auto' })).toBeNull();
        expect(square({ style: 'x:-5px;width:20px' })).toBe('M-5,0h20v10h-20z');
    });

    it('reads rx / ry from style, auto included', () => {
        expect(square({ style: 'rx:3px' })).toBe(square({ rx: '3' }));
        expect(square({ rx: '2', style: 'rx:auto' })).toBe('M0,0h10v10h-10z');
        expect(ellipse({ style: 'rx:auto;ry:4px' })).toBe(ellipse({ rx: '4', ry: '4' }));
        expect(ellipse({ style: 'rx:auto;ry:auto' })).toBeNull();
    });

    it('ignores an invalid declaration: the attribute applies', () => {
        for (const style of ['r:-10px', 'r:bogus', 'r:auto', 'r:1ex', 'r:'])
            expect(circle({ style }), style).toBe(circle({}));
        expect(square({ rx: '1', style: 'rx:-3px' })).toBe(square({ rx: '1' }));
    });

    it('keeps the last valid declaration, !important included', () => {
        expect(square({ style: 'width:20px;width:bogus' })).toBe(square({ width: '20' }));
        expect(circle({ style: 'r: 7px !important' })).toBe(circle({ r: '7' }));
    });

    it('resolves CSS-wide keywords to the initial value', () => {
        expect(circle({ style: 'cx:initial' })).toBe(circle({ cx: '0' }));
        expect(square({ rx: '2', style: 'rx:unset' })).toBe('M0,0h10v10h-10z');
    });

    it('ignores properties that are not geometry properties of the element', () => {
        expect(shapeToPathData('line', { x2: '10', y2: '10', style: 'x1:5px' })).toBe('M0,0L10,10');
        expect(circle({ style: 'width:20px;rx:3px' })).toBe(circle({}));
    });

    const svgOf = (shape: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${shape}</svg>`;
    const pathData = (xml: string) => [...xml.matchAll(/android:pathData="([^"]*)"/g)].map((m) => m[1]);

    for (const optimize of [true, false]) {
        it(`draws a circle laid out by style only (optimize: ${optimize})`, () => {
            const { xml } = convert(svgOf('<circle style="cx:12px;cy:12px;r:5px"/>'), { optimize, strict: true });
            expect(pathData(xml)).toEqual(['M7,12a5,5 0 1 0 10,0a5,5 0 1 0 -10,0z']);
        });

        // svgo's convertShapeToPath turns a shape with complete attributes into a path from the
        // attributes alone, ignoring the style: optimize: true keeps such shapes as elements.
        it(`lets style override a complete set of attributes (optimize: ${optimize})`, () => {
            const circleOut = convert(svgOf('<circle cx="12" cy="12" r="5" style="r:8px"/>'), { optimize });
            expect(pathData(circleOut.xml)).toEqual(['M4,12a8,8 0 1 0 16,0a8,8 0 1 0 -16,0z']);
            const rectOut = convert(svgOf('<rect width="10" height="10" style="height:0"/>'), { optimize });
            expect(rectOut.warnings.map((w) => w.code)).toEqual(['empty-path']);
        });
    }

    const shapesWith = (style: string) =>
        svgOf(
            `<circle cx="12" cy="12" r="5" style="${style}"/><rect x="1" y="1" width="4" height="4" style="${style}"/>`,
        );

    it('keeps shapes for the converter when any CSS geometry property may be set (optimize: true)', () => {
        const declarations = ['cx:13px', 'cy:13px', 'r:6px', 'rx:1px', 'ry:1px', 'x:2px', 'y:2px'];
        for (const style of [...declarations, 'width:3px', 'height:3px', 'fill:red; R : 6px', 'fill:red;Width:3px']) {
            const svg = shapesWith(style);
            expect(pathData(convert(svg, { optimize: true }).xml), style).toEqual(
                pathData(convert(svg, { optimize: false }).xml),
            );
        }
        const rule = svgOf('<style>rect { height: 0 }</style><rect width="10" height="10"/>');
        expect(convert(rule, { optimize: true }).warnings.map((w) => w.code)).toEqual(['empty-path']);
    });

    it('still lets svgo convert shapes styled by ordinary icon properties (optimize: true)', () => {
        const plain = pathData(convert(shapesWith(''), { optimize: true }).xml);
        expect(plain).not.toEqual(pathData(convert(shapesWith(''), { optimize: false }).xml));
        const ordinary = [
            'fill:red;fill-opacity:.5;fill-rule:evenodd',
            'stroke:#000;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke-miterlimit:4',
            'opacity:.5;color:red;cursor:pointer;filter:none;display:inline',
            'max-width:3px;min-height:2px;line-height:2;font-size:12px;letter-spacing:1px',
            'box-sizing:border-box;overflow:visible;mix-blend-mode:normal',
        ];
        for (const style of ordinary) {
            expect(pathData(convert(shapesWith(style), { optimize: true }).xml), style).toEqual(plain);
        }
    });

    it('applies <style> rules once svgo inlines them (wpt geometry/reftests/circle-001.svg)', () => {
        const svg =
            '<svg width="340" height="140" xmlns="http://www.w3.org/2000/svg">' +
            '<style>circle { cx: 204px; cy: 56px; r: 65px; fill: blue; }</style><circle /></svg>';
        const { xml, warnings } = convert(svg, { optimize: true });
        expect(warnings.map((w) => w.code)).toEqual(['large-vector']);
        expect(pathData(xml)).toEqual(['M139,56a65,65 0 1 0 130,0a65,65 0 1 0 -130,0z']);
    });
});

describe('CSS d property on <path> (SVG 2 §9.3.1: the declaration wins over the attribute)', () => {
    const svgOf = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">${body}</svg>`;
    const pathsOf = (xml: string) => [...xml.matchAll(/android:pathData="([^"]*)"/g)].map((m) => m[1]);
    const square = 'M0 0H100V100H0Z';

    describe('wpt-path-d-property.svg renders like its reference (wpt path/property/priority-ref.svg)', () => {
        const svg = readFileSync(fileURLToPath(new URL('wpt-repro/wpt-path-d-property.svg', import.meta.url)), 'utf8');
        // resvg ignores the CSS d property: compare with the reference, not the source.
        const reference = svgOf(
            '<path d="M 20 10 h 70" stroke="blue" stroke-width="3"/><path d="M 20 80 h 70" stroke="blue" stroke-width="3"/>',
        );

        it('optimize: true (the <style> rule is inlined by svgo)', () => {
            const { xml, warnings } = convert(svg, { optimize: true, strict: true });
            expect(warnings).toEqual([]);
            const result = compareSvgs(reference, vdToSvg(xml));
            expect(result.sizeMismatch).toBeNull();
            expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        });

        it('optimize: false (the inline style applies; the <style> rule is reported)', () => {
            const { xml, warnings } = convert(svg, { optimize: false });
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-style']);
            expect(pathsOf(xml)[1]).toBe('M 20 80 h 70');
            expect(() => convert(svg, { optimize: false, strict: true })).toThrow();
        });
    });

    for (const optimize of [true, false]) {
        describe(`optimize: ${optimize}`, () => {
            const run = (body: string) => convert(svgOf(body), { optimize, strict: true });

            it('draws a path whose only geometry is the CSS property', () => {
                const { xml } = run(`<path style="d: path('M 20 80 h 70')" stroke="blue"/>`);
                expect(pathsOf(xml)).toEqual(['M 20 80 h 70']);
            });

            it('draws nothing, silently, for d: none (wpt path/property/d-none.svg)', () => {
                const { xml, warnings } = run(
                    `<path d="${square}" fill="green"/><path d="${square}" fill="red" style="d: none"/>`,
                );
                expect(warnings).toEqual([]);
                expect(pathsOf(xml)).toHaveLength(1);
                expect(xml).not.toContain('#FF0000');
                for (const none of ['NONE', 'initial', 'path("")'])
                    expect(pathsOf(run(`<path d="${square}" style='d: ${none}'/>`).xml), none).toEqual([]);
            });

            it('keeps the last valid declaration, !important over normal ones', () => {
                const pick = (style: string) => pathsOf(run(`<path d="${square}" style="${style}"/>`).xml);
                expect(pick(`d:path('M1 1h5');d:path('M2 2h5')`)).toEqual(['M2 2h5']);
                expect(pick(`d:path('M1 1h5') !important;d:path('M2 2h5')`)).toEqual(['M1 1h5']);
                expect(pick(`D: PATH(&quot;M1 1h5&quot;)`)).toEqual(['M1 1h5']);
                // Invalid declarations are ignored: the previous one, then the attribute, applies
                // (with optimize: true, the cascade runs before svgo's minifyStyles merges them).
                expect(pick(`d:path('M1 1h5');d:path('M2 2 L')`)).toEqual(['M1 1h5']);
                expect(pick(`d:path('M1 1h5');d:bogus`)).toEqual(['M1 1h5']);
                expect(pick(`d:url(#a)`).length).toBe(1);
                expect(pick(`d:path(evenodd, 'M1 1h5')`).length).toBe(1);
            });

            it('leaves the property to <path>: a <rect> stays a rect (svgo convertShapeToPath kept off)', () => {
                const { xml } = run(`<rect width="10" height="10" style="d:path('M50 50h10v10h-10z')"/>`);
                expect(pathsOf(xml)).toEqual(['M0,0h10v10h-10z']);
            });

            it('draws two translucent paths sharing a CSS d twice (svgo mergePaths kept off)', () => {
                // Disjoint attributes: svgo would merge them (it skips intersecting paths).
                const twin = (d: string) => `<path d="${d}" fill-opacity=".5" style="d:path('M50 50h10v10h-10z')"/>`;
                expect(pathsOf(run(twin('M0 0H10V10H0Z') + twin('M20 20H30V30H20Z')).xml)).toEqual([
                    'M50 50h10v10h-10z',
                    'M50 50h10v10h-10z',
                ]);
            });

            it.each(['var(--d)', 'env(x)', 'attr(data-d)', 'inherit', 'revert'])(
                'reports d: %s as unsupported-style, not empty-path (rejected in strict mode)',
                (value) => {
                    const svg = svgOf(`<path d="${square}" fill="red" style="d: ${value}"/><path d="${square}"/>`);
                    expect(() => convert(svg, { optimize, strict: true })).toThrow(/d: .* cannot be resolved/);
                    const { xml, warnings } = convert(svg, { optimize });
                    expect(warnings.map((w) => w.code)).toEqual(['unsupported-style']);
                    expect(pathsOf(xml)).toHaveLength(1);
                    expect(xml).not.toContain('#FFFF0000');
                },
            );
        });
    }
});

/**
 * T-178: SVG numbers are floats in browsers and in Android's PathParser. A shape whose geometry leaves
 * the float range (~3.4e38) is not drawn, as in Firefox (Chrome clamps it); verified in Firefox 158 and
 * Chrome 157 on 2026-11-13. Both draw up to 1e37.
 */
describe('geometry beyond the float range (T-178)', () => {
    const svg = (body: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;

    it.each([
        ['circle r', '<circle cx="12" cy="12" r="1e400"/>'],
        ['circle r above the float', '<circle cx="12" cy="12" r="1e39"/>'],
        ['circle whose diameter overflows', '<circle cx="12" cy="12" r="2e38"/>'],
        ['circle cx', '<circle cx="1e400" cy="12" r="5"/>'],
        ['ellipse rx', '<ellipse cx="12" cy="12" rx="1e400" ry="5"/>'],
        ['rect width', '<rect width="1e400" height="5"/>'],
        ['rect width above the float', '<rect width="1e39" height="5"/>'],
        ['line x2', '<line x1="0" y1="0" x2="1e400" y2="0" stroke="#000"/>'],
        ['polyline point', '<polyline points="0 0 1e400 5 10 10" stroke="#000"/>'],
    ])('%s: nothing drawn, empty-path, in both modes', (_, body) => {
        for (const optimize of [true, false]) {
            const { xml, warnings } = convert(svg(body), { optimize });
            expect(xml, `optimize: ${optimize}`).not.toContain('pathData');
            expect(warnings.map((w) => w.code)).toContain('empty-path');
        }
    });

    it('draws nothing for a polygon with a point that overflows (an error, T-182)', () => {
        expect(shapeToPathData('polygon', { points: '0 0 10 0 10 10 1e400 5' })).toBeNull();
    });

    it('keeps a large geometry within the float range', () => {
        expect(shapeToPathData('rect', { width: '1e37', height: '5' })).toBe('M0,0h1e+37v5h-1e+37z');
    });
});

/**
 * T-182: a `points` list in error draws nothing, an odd trailing coordinate is ignored, a polygon is
 * closed. Verified in Firefox and Chrome on 2026-11-14 (filled and stroked): both draw nothing for a
 * list in error, not the prefix SVG 2 §10.10 describes. Where they differ (a trailing comma, `.1.5`,
 * `10+5`, a y token `10-5`), Chrome reads on and Firefox draws nothing; the converter follows Firefox.
 */
describe('polygon / polyline points in error or with an odd count (T-182)', () => {
    const svg = (el: string, points: string, paint: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
        `<${el} points="${points}" ${paint}/></svg>`;
    const paints = [
        ['filled', 'fill="red"'],
        ['stroked', 'fill="none" stroke="#000" stroke-width="2"'],
    ] as const;
    const pathDataOf = (xml: string): string[] => [...xml.matchAll(/android:pathData="([^"]*)"/g)].map((m) => m[1]!);

    it.each([
        ['a non-number', '0 0 10 0 x 10 10 0 10'],
        ['a unit', '0 0 10 0 10px 10 0 10'],
        ['an empty item between commas', '0 0 10 0 , , 10 10'],
        ['a trailing comma', '0 0 10 0 10 10 0 10 ,'],
        ['a leading comma', ', 0 0 10 0 10 10 0 10'],
        ['an error after an odd count', '0 0 10 0 10 10 x'],
        ['a trailing dot', '0 0 10 0 10 10 0 10.'],
        ['an exponent without digits', '0 0 10 0 10 10 0 1e'],
        ['a y token holding the next x', '0 0 10 0 10 10 0 10-5 5'],
        ['NaN', '0 0 10 0 10 10 0 10 NaN'],
    ])('%s: nothing drawn, empty-path, in both modes', (_, points) => {
        for (const el of ['polygon', 'polyline']) {
            expect(shapeToPathData(el, { points })).toBeNull();
            for (const [label, paint] of paints) {
                for (const optimize of [true, false]) {
                    const { xml, warnings } = convert(svg(el, points, paint), { optimize });
                    const where = `${el} ${label}, optimize: ${optimize}`;
                    expect(pathDataOf(xml), where).toEqual([]);
                    expect(
                        warnings.map((w) => w.code),
                        where,
                    ).toContain('empty-path');
                }
            }
        }
    });

    // [case, points, polygon path data with optimize: true, then with optimize: false]
    it.each([
        ['an odd count', '0 0 10 0 10 10 0', 'M0 0h10v10z', 'M0,0L10,0L10,10z'],
        ['an odd count with an exponent', '0 0,10 0,10,10 1e2', 'M0 0h10v10z', 'M0,0L10,0L10,10z'],
        ['an odd count of two points', '0 0 10 0 10', 'M0 0h10z', 'M0,0L10,0z'],
        ['an x token holding its y', '0 0 10 0 10-10 0 10', 'M0 0h10v-10L0 10z', 'M0,0L10,0L10,-10L0,10z'],
    ])('%s: drawn as the browsers do, alike in both modes', (_, points, optimized, unoptimized) => {
        for (const el of ['polygon', 'polyline']) {
            // A polyline is the polygon without its closing `z`.
            const open = (d: string): string => (el === 'polygon' ? d : d.slice(0, -1));
            expect(shapeToPathData(el, { points })).toBe(open(unoptimized));
            for (const [label, paint] of paints) {
                for (const [optimize, d] of [
                    [true, optimized],
                    [false, unoptimized],
                ] as const) {
                    const { xml, warnings } = convert(svg(el, points, paint), { optimize });
                    const where = `${el} ${label}, optimize: ${optimize}`;
                    expect(pathDataOf(xml), where).toEqual([open(d)]);
                    expect(warnings, where).toEqual([]);
                }
            }
        }
    });
});
