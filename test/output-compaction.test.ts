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
        expect(pathData('M1.23456 2.5', 1)).toBe('M1.2 2.5');
    });

    it('leaves short numbers and formatting byte-identical', () => {
        for (const d of ['M0 0h24v24H0z', 'M 1,2 L 3.5 , 4.25 Z', 'M1.5.5l-.25-1e2', 'M-0 -0.5c1 2 3 4 5 6z']) {
            expect(pathData(d)).toBe(d);
        }
    });

    it('handles scientific notation and keeps tokens separated', () => {
        expect(pathData('M1e-7 2E-9L1.23456e1 5')).toBe('M0 0L12.346 5');
        // A rounded number losing its sign or its dot must not merge with its neighbour.
        expect(pathData('M1-0.00001 2')).toBe('M1 0 2');
        expect(pathData('M.5.00001 2')).toBe('M.5 0 2');
        expect(pathData('M1.00001.5 2')).toBe('M1 .5 2');
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
