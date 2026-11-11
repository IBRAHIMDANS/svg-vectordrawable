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
