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
        // attributes alone, before the style is read: with optimize: true the CSS is lost.
        it.skipIf(optimize)(`lets style override a complete set of attributes (optimize: ${optimize})`, () => {
            const circleOut = convert(svgOf('<circle cx="12" cy="12" r="5" style="r:8px"/>'), { optimize });
            expect(pathData(circleOut.xml)).toEqual(['M4,12a8,8 0 1 0 16,0a8,8 0 1 0 -16,0z']);
            const rectOut = convert(svgOf('<rect width="10" height="10" style="height:0"/>'), { optimize });
            expect(rectOut.warnings.map((w) => w.code)).toEqual(['empty-path']);
        });
    }

    it('applies <style> rules once svgo inlines them (wpt geometry/reftests/circle-001.svg)', () => {
        const svg =
            '<svg width="340" height="140" xmlns="http://www.w3.org/2000/svg">' +
            '<style>circle { cx: 204px; cy: 56px; r: 65px; fill: blue; }</style><circle /></svg>';
        const { xml, warnings } = convert(svg, { optimize: true });
        expect(warnings.map((w) => w.code)).toEqual(['large-vector']);
        expect(pathData(xml)).toEqual(['M139,56a65,65 0 1 0 130,0a65,65 0 1 0 -130,0z']);
    });
});
