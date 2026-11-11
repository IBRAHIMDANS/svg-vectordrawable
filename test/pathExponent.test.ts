import { describe, expect, it } from 'vitest';
import { dashPathData } from '../src/dash.js';
import { convert } from '../src/index.js';
import {
    evenOddToNonZero,
    normalizeArcFlags,
    pathBBox,
    reversePathData,
    transformPathData,
    windingSign,
} from '../src/pathData.js';
import { IDENTITY, type Matrix } from '../src/transform.js';

/**
 * Regressions for T-10: a number in scientific notation (`2e1`) used to stop `parsePath`, so every
 * caller silently lost the rest of the path. Each caller must give the same result on a path written
 * with exponents as on the same path written plainly.
 */

/** Same geometry, written with exponents and plainly. */
const SQUARE_EXP = 'M0 0H2e1V2E1H0ZM5 5H1.5e1V15e-0H5Z';
const SQUARE = 'M0 0H20V20H0ZM5 5H15V15H5Z';

const svg = (body: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;
const pathDatas = (xml: string): string[] => [...xml.matchAll(/android:pathData="([^"]*)"/g)].map((m) => m[1]!);

describe('parsePath callers on exponent numbers', () => {
    it('pathBBox', () => {
        expect(pathBBox('M0 0L2e1 2')).toEqual({ x: 0, y: 0, width: 20, height: 2 });
        expect(pathBBox(SQUARE_EXP)).toEqual(pathBBox(SQUARE));
    });

    it('transformPathData', () => {
        const skew: Matrix = { a: 1, b: 0, c: 0.5, d: 1, e: 3, f: 0 };
        expect(transformPathData(SQUARE_EXP, skew)).toBe(transformPathData(SQUARE, skew));
        expect(transformPathData('M0 0L1e-170 0', IDENTITY)).toBe('M0 0L0 0');
    });

    it('pathContours: reversePathData, windingSign, evenOddToNonZero', () => {
        expect(reversePathData(SQUARE_EXP)).toBe(reversePathData(SQUARE));
        expect(windingSign(SQUARE_EXP)).toBe(windingSign(SQUARE));
        // Nested contours of the same orientation: rewritten (not returned as is), so it was parsed.
        expect(evenOddToNonZero(SQUARE_EXP)).not.toBe(SQUARE_EXP);
        expect(evenOddToNonZero(SQUARE_EXP)).toBe(evenOddToNonZero(SQUARE));
    });

    it('dashPathData', () => {
        expect(dashPathData('M0 0L2e1 0', [4, 2], 0, 0.1)).toBe(dashPathData('M0 0L20 0', [4, 2], 0, 0.1));
        expect(dashPathData('M0 0L2e1 0', [4, 2], 0, 0.1)).toContain('L20 0');
    });

    it('normalizeArcFlags separates compact flags after an exponent', () => {
        expect(normalizeArcFlags('M0 0L1e1 0a5 5 0 0110 0Z')).toBe('M0 0L1e1 0a5 5 0 0 1 10 0Z');
    });
});

describe.each([true, false])('convert with exponent path data (optimize: %s)', (optimize) => {
    it('dashes a stroke-dasharray path', () => {
        const { xml, warnings } = convert(
            svg('<path d="M0 0L2e1 2" fill="none" stroke="#000" stroke-dasharray="4 2"/>'),
            { optimize },
        );
        expect(warnings).toEqual([]);
        expect(pathDatas(xml)).toEqual([
            'M0 0L3.98 0.398M5.97 0.597L9.95 0.995M11.94 1.194L15.921 1.592M17.911 1.791L20 2',
        ]);
    });

    it('keeps the whole geometry of a baked transform', () => {
        const { xml } = convert(svg('<path d="M0 0L2e1 2L2 2e1Z" transform="skewX(10)"/>'), { optimize });
        expect(pathDatas(xml)[0]).toMatch(/20\.353 2L5\.527 20Z$/);
    });

    it('separates compact arc flags in a clip path and a plain path', () => {
        const d = 'M0 0L1e1 0a5 5 0 0110 0Z';
        const { xml } = convert(
            svg(`<clipPath id="c"><path d="${d}"/></clipPath><path d="${d}" clip-path="url(#c)"/>`),
            { optimize },
        );
        const datas = pathDatas(xml);
        expect(datas.length).toBeGreaterThanOrEqual(2);
        for (const data of datas) expect(data).toMatch(/a5 5 0 0 1 10 0Z$/);
    });

    it('maps an objectBoundingBox gradient on the full bbox, without approximation', () => {
        const { warnings } = convert(
            svg(
                '<linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>' +
                    '</linearGradient><path d="M0 0H2e1V2e1Z" fill="url(#g)"/>',
            ),
            { optimize },
        );
        expect(warnings).toEqual([]);
    });
});
