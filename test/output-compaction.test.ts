import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';
import { vdToSvg } from './visual/vdToSvg.js';

const svg = (body: string, attrs = ''): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"${attrs}>${body}</svg>`;

const VISIBLE = '<path d="M4 4h16v16H4z" fill="#ff0000"/>';

/** Tabler's invisible bounding box, found at the top of every Tabler icon. */
const TABLER_BOX = '<path stroke="none" fill="none" d="M0 0h24v24H0z"/>';

const both = [true, false] as const;

describe('invisible drawables are dropped', () => {
    for (const optimize of both) {
        describe(`optimize: ${optimize}`, () => {
            const run = (body: string, attrs = '') => convert(svg(body, attrs), { optimize });

            it('drops a Tabler-like invisible bounding box, without a warning', () => {
                const { xml, warnings } = run(TABLER_BOX + VISIBLE);
                expect(xml).not.toContain('M0 0h24v24H0z');
                expect(xml.match(/<path/g)).toHaveLength(1);
                expect(warnings).toEqual([]);
            });

            it('drops fill="none" with stroke-width="0"', () => {
                const { xml, warnings } = run(
                    '<path d="M1 1h5v5H1z" fill="none" stroke="#000" stroke-width="0"/>' + VISIBLE,
                );
                expect(xml.match(/<path/g)).toHaveLength(1);
                expect(warnings).toEqual([]);
            });

            it('drops opacity="0", fill-opacity="0" and transparent colors', () => {
                const invisible = [
                    '<path d="M1 1h5v5H1z" fill="#000" stroke="#000" opacity="0"/>',
                    '<path d="M1 1h5v5H1z" fill="#000" fill-opacity="0"/>',
                    '<path d="M1 1h5v5H1z" fill="rgba(0,0,0,0)"/>',
                    '<path d="M1 1h5v5H1z" fill="transparent" stroke="rgba(10,20,30,0)"/>',
                    '<path d="M1 1h5v5H1z" fill="none" stroke="#000" stroke-opacity="0"/>',
                ];
                for (const p of invisible) {
                    const { xml, warnings } = run(p + VISIBLE);
                    expect(xml.match(/<path/g), p).toHaveLength(1);
                    expect(warnings, p).toEqual([]);
                }
            });

            it('drops a group left empty', () => {
                const { xml } = run(`<g transform="translate(2 3)">${TABLER_BOX}</g>${VISIBLE}`);
                expect(xml).not.toContain('<group');
                expect(xml.match(/<path/g)).toHaveLength(1);
            });

            it('drops a clip wrapper left empty', () => {
                const { xml } = run(
                    '<defs><clipPath id="c"><rect x="0" y="0" width="12" height="12"/></clipPath></defs>' +
                        `<path clip-path="url(#c)" fill="none" d="M1 1h5v5H1z"/>${VISIBLE}`,
                );
                expect(xml).not.toContain('<group');
                expect(xml).not.toContain('<clip-path');
                expect(xml.match(/<path/g)).toHaveLength(1);
            });

            it('keeps a clip wrapper whose content is visible', () => {
                const { xml } = run(
                    '<defs><clipPath id="c"><rect x="0" y="0" width="12" height="12"/></clipPath></defs>' +
                        `<g clip-path="url(#c)">${TABLER_BOX}${VISIBLE}</g>`,
                );
                expect(xml).toContain('<clip-path');
                expect(xml.match(/<path/g)).toHaveLength(1);
            });

            it('drops the viewBox-offset group when everything is invisible, keeping a valid <vector>', () => {
                const { xml, warnings } = convert(
                    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 5 24 24">${TABLER_BOX}</svg>`,
                    { optimize },
                );
                expect(xml).not.toContain('<path');
                expect(xml).not.toContain('<group');
                expect(xml).toMatch(/^<vector [^]*android:viewportHeight="24">\n*<\/vector>\n$/);
                expect(warnings).toEqual([]);
            });

            it('keeps visible paths untouched', () => {
                const body =
                    '<path d="M2 2h4v4H2z" fill="#00ff00" fill-opacity="0.5"/>' +
                    '<path d="M8 8h4v4H8z" fill="none" stroke="#0000ff" stroke-width="2"/>' +
                    '<path d="M14 14h4v4h-4z" fill="#000" stroke="none" opacity="0.01"/>';
                const { xml } = run(body);
                expect(xml.match(/<path/g)).toHaveLength(3);
            });

            it('keeps the stroke path of a dashed stroke whose fill is transparent', () => {
                const { xml } = run(
                    '<path d="M2 12h20" fill="rgba(0,0,0,0)" stroke="#000" stroke-width="2" stroke-dasharray="4 2"/>',
                );
                expect(xml.match(/<path/g)).toHaveLength(1);
                expect(xml).toContain('android:strokeColor');
            });

            it('renders like the source (visual harness)', () => {
                const cases = [
                    TABLER_BOX + '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="#000" stroke-width="2"/>',
                    `<g transform="translate(2 3)">${TABLER_BOX}</g>${VISIBLE}`,
                    '<defs><clipPath id="c"><rect width="12" height="12"/></clipPath></defs>' +
                        `<g clip-path="url(#c)">${TABLER_BOX}<circle cx="12" cy="12" r="8" fill="#08f"/></g>`,
                ];
                for (const body of cases) {
                    const source = svg(body);
                    const result = compareSvgs(source, vdToSvg(convert(source, { optimize }).xml));
                    expect(result.inked).toBeGreaterThan(0);
                    expect(result.mismatch, body).toBeLessThan(DEFAULT_MAX_MISMATCH);
                }
            });
        });
    }
});

describe('raw pathData is rounded to floatPrecision with optimize:false', () => {
    const pathData = (d: string, floatPrecision?: number): string => {
        const { xml } = convert(svg(`<path d="${d}"/>`), {
            optimize: false,
            ...(floatPrecision === undefined ? {} : { floatPrecision }),
        });
        return /android:pathData="([^"]*)"/.exec(xml)![1]!;
    };

    it('rounds long decimals only', () => {
        expect(pathData('M1.23456 2.5L3.1415926,4')).toBe('M1.235 2.5L3.142,4');
        expect(pathData('M1.23456 2.5h1', 1)).toBe('M1.2 2.5h1');
    });

    it('leaves short numbers and formatting byte-identical', () => {
        for (const d of ['M0 0h24v24H0z', 'M 1,2 L 3.5 , 4.25 Z', 'M1.5.5l-.25-1e2', 'M-0 -0.5c1 2 3 4 5 6z']) {
            expect(pathData(d)).toBe(d);
        }
    });

    it('handles scientific notation and keeps tokens separated', () => {
        expect(pathData('M1e-7 2E-9L1.23456e1 5')).toBe('M0 0L12.346 5');
        // A rounded number losing its sign or its dot must not merge with its neighbour.
        expect(pathData('M1-0.00001 2 3')).toBe('M1 0 2 3');
        expect(pathData('M.5.00001 2 3')).toBe('M.5 0 2 3');
        expect(pathData('M1.00001.5 2 3')).toBe('M1 .5 2 3');
    });

    it('keeps arc flags separated', () => {
        expect(pathData('M2 2a1.23456 1.23456 0 01.123456.5')).toBe('M2 2a1.235 1.235 0 0 1 0.123.5');
        expect(pathData('M2 2a1 1 0 1 1-0.00001 2')).toBe('M2 2a1 1 0 1 1 0 2');
    });

    it('renders like the source (visual harness)', () => {
        const source = svg('<path d="M3.0000001 3.123456L20.987654 3.5a8.0000004 8 0 01-8.5 17z" fill="#c00"/>');
        const result = compareSvgs(source, vdToSvg(convert(source, { optimize: false }).xml));
        expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
    });
});

describe('evenodd rewritten to nonzero (minSdk < 24) stays compact', () => {
    const pathData = (d: string, minSdk: number): { d: string; evenOdd: boolean } => {
        const { xml } = convert(svg(`<path fill-rule="evenodd" d="${d}"/>`), { minSdk });
        return { d: /android:pathData="([^"]*)"/.exec(xml)![1]!, evenOdd: xml.includes('evenOdd') };
    };

    it('keeps the path data of disjoint contours, whatever their orientations, and drops fillType', () => {
        for (const d of ['M2 2h8v8H2zM14 14h8v8h-8z', 'M2 2h8v8H2zm12 12v8h8v-8z']) {
            const low = pathData(d, 21);
            expect(low.evenOdd, d).toBe(false);
            expect(low.d, d).toBe(pathData(d, 24).d);
        }
    });

    it('reverses an arc as an arc, its sweep flag inverted', () => {
        const d = 'M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20zm0 4a6 6 0 1 0 0 12 6 6 0 1 0 0-12z';
        expect(pathData(d, 21)).toEqual({
            d: 'M12 2a10 10 0 1 0 0 20A10 10 0 1 0 12 2ZM12 6a6 6 0 1 1 0 12A6 6 0 1 1 12 6Z',
            evenOdd: false,
        });
    });

    it('writes no leading zero and no repeated command letter', () => {
        expect(pathData('M2 2h20v20H2zM6.5 6.25h11.5v.5H6.5z', 21).d).toBe('M2 2H22V22H2ZM6.5 6.25v.5H18v-.5Z');
        expect(pathData('M2 2h20v20H2zM4 4h16v16H4z', 21).d).toBe('M2 2H22V22H2ZM4 4V20H20V4Z');
        // Bootstrap Icons' arrow-down-circle: a ring around an arrow, the arrow reversed.
        const arrow =
            'M1 8a7 7 0 1 0 14 0A7 7 0 0 0 1 8m15 0A8 8 0 1 1 0 8a8 8 0 0 1 16 0M8.5 4.5a.5.5 0 0 0-1 0v5.793L5.354 ' +
            '8.146a.5.5 0 1 0-.708.708l3 3a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293z';
        const low = pathData(arrow, 21);
        expect(low.evenOdd).toBe(false);
        expect(low.d).not.toMatch(/[cC]|(^|[^\d])0\.\d/);
        expect(low.d.length / pathData(arrow, 24).d.length).toBeLessThanOrEqual(1.1);
    });

    it('keeps arc flags separated from the next number', () => {
        expect(pathData('M2 2h20v20H2zM15.25 12.25a3 3 0 1 1-6 0 3 3 0 1 1 6 0z', 21).d).toBe(
            'M2 2H22V22H2ZM15.25 12.25a3 3 0 1 0 -6 0 3 3 0 1 0 6 0Z',
        );
    });

    it('renders like the source (visual harness)', () => {
        for (const d of [
            'M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20zm0 4a6 6 0 1 0 0 12 6 6 0 1 0 0-12z',
            'M2 2h20v20H2zM6.5 6.25h11.5v.5H6.5zM15.25 12.25a3 3 0 1 1-6 0 3 3 0 1 1 6 0z',
            'M2 2h8v8H2zm12 12v8h8v-8z',
        ]) {
            const source = svg(`<path fill-rule="evenodd" d="${d}"/>`);
            const { xml } = convert(source, { minSdk: 21 });
            expect(xml, d).not.toContain('evenOdd');
            const result = compareSvgs(source, vdToSvg(xml));
            expect(result.inked).toBeGreaterThan(0);
            expect(result.mismatch, d).toBeLessThan(DEFAULT_MAX_MISMATCH);
        }
    });
});

describe('a mask converted to a clip writes a compact clip path', () => {
    const masked = (mask: string, maskAttrs = ''): string =>
        svg(`<defs><mask id="m"${maskAttrs}>${mask}</mask></defs><path mask="url(#m)" d="M0 0h24v24H0z" fill="#c00"/>`);
    const clipPaths = (xml: string): string[] =>
        [...xml.matchAll(/<clip-path[^>]*android:pathData="([^"]*)"/g)].map((m) => m[1]!);
    const WHITE_RECT = '<rect width="10" height="10" fill="#fff"/>';
    const REGION = [
        '<rect width="20" height="20" fill="#fff"/>',
        ' maskUnits="userSpaceOnUse" x="2" y="2" width="8" height="8"',
    ] as const;
    const HOLE = '<rect width="20" height="20" fill="#fff"/><rect x="4" y="4" width="4" height="4" fill="#000"/>';
    const UNION = '<rect x="1" y="1" width="5" height="5" fill="#fff"/><circle cx="15" cy="15" r="4" fill="#fff"/>';

    for (const optimize of both) {
        describe(`optimize: ${optimize}`, () => {
            it('writes a white rectangle with H / V (no L, no closing line)', () => {
                expect(clipPaths(convert(masked(WHITE_RECT), { optimize }).xml)).toEqual(['M0 0H10V10H0Z']);
            });

            it('writes the mask region compactly', () => {
                expect(clipPaths(convert(masked(...REGION), { optimize }).xml)).toEqual([
                    'M0 0H20V20H0Z',
                    'M2 2h8v8H2Z',
                ]);
            });

            it('writes a rectangle with a hole compactly', () => {
                expect(clipPaths(convert(masked(HOLE), { optimize }).xml)).toEqual(['M0 0H20V20H0ZM4 4V8H8V4Z']);
            });

            it('writes a union of pieces compactly, curves included', () => {
                const [d] = clipPaths(convert(masked(UNION), { optimize }).xml);
                expect(d).toMatch(/^M1 1H6V6H1ZM1[15] 1[15]c.*Z$/);
                expect(d).not.toMatch(/[LC]/);
            });

            it('still hides an element whose mask draws nothing (empty clip left as is)', () => {
                const { xml } = convert(masked('<rect width="0" height="5" fill="#fff"/>'), { optimize });
                expect(xml).not.toContain('<path');
                expect(xml).not.toContain('<clip-path');
            });

            it('renders like the source (visual harness)', () => {
                for (const [mask, attrs] of [[WHITE_RECT], REGION, [HOLE], [UNION]]) {
                    const source = masked(mask!, attrs);
                    const result = compareSvgs(source, vdToSvg(convert(source, { optimize }).xml));
                    expect(result.inked).toBeGreaterThan(0);
                    expect(result.mismatch, mask).toBeLessThan(DEFAULT_MAX_MISMATCH);
                }
            });
        });
    }
});
