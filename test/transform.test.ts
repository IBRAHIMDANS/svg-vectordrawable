import { describe, expect, it } from 'vitest';
import { convert } from '../src/index.js';
import { IDENTITY, isInvalidTransform, parseCssTransform, parseTransform, type Matrix } from '../src/transform.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';
import { vdToSvg } from './visual/vdToSvg.js';

const svg = (body: string): string =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${body}</svg>`;

describe('parseTransform', () => {
    it.each([
        ['translate(10 5)', { a: 1, b: 0, c: 0, d: 1, e: 10, f: 5 }],
        ['translate(10)', { a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 }],
        ['translate(10-5)', { a: 1, b: 0, c: 0, d: 1, e: 10, f: -5 }],
        ['scale(2),translate(1,1)', { a: 2, b: 0, c: 0, d: 2, e: 2, f: 2 }],
        ['  matrix(1 0 0 1 3 4)  ', { a: 1, b: 0, c: 0, d: 1, e: 3, f: 4 }],
    ])('reads %s', (value, expected) => {
        expect(parseTransform(value)).toEqual(expected);
    });

    it('reads rotate with a center', () => {
        const m = parseTransform('rotate(90 10 10)')!;
        expect(m.e).toBeCloseTo(20);
        expect(m.f).toBeCloseTo(0);
    });

    it.each([
        'translate(foo 5)',
        'translate(10px 5px)',
        'translate()',
        'translate(1 2 3)',
        'rotate(10 5)',
        'scale(1,)',
        'matrix(1 0 0 1 3)',
        'skewX(1 2)',
        'translate(10) foo',
        'translate(10) perspective(5)',
        'translate(10),',
    ])('rejects the whole list for %s', (value) => {
        expect(parseTransform(value)).toBeNull();
        expect(isInvalidTransform(value)).toBe(true);
    });

    it.each([undefined, '', '  ', 'none'])('treats %j as no transform, not an invalid one', (value) => {
        expect(parseTransform(value)).toBeNull();
        expect(isInvalidTransform(value)).toBe(false);
    });
});

describe('invalid transform attribute', () => {
    for (const optimize of [true, false]) {
        it(`renders translate(foo 5) untransformed with a warning (optimize: ${optimize})`, () => {
            const { xml, warnings } = convert(svg('<g transform="translate(foo 5)"><path d="M0 0h4v4z"/></g>'), {
                optimize,
            });
            expect(xml).not.toContain('translate');
            expect(xml).toContain('M0 0h4v4z');
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
        });

        it(`reports an invalid transform on a drawable element once (optimize: ${optimize})`, () => {
            const { xml, warnings } = convert(svg('<path transform="translate(10px 5px)" d="M0 0h4v4z"/>'), {
                optimize,
            });
            expect(xml).toContain('M0 0h4v4z');
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
        });

        it(`keeps the valid transform of the parent group (optimize: ${optimize})`, () => {
            const { xml, warnings } = convert(
                svg('<g transform="translate(2 2)"><path transform="translate(foo 5)" d="M0 0h4v4z"/></g>'),
                { optimize },
            );
            expect(xml).toMatch(/M2[ ,]2h4v4z|android:translateX="2"\s+android:translateY="2"/);
            expect(xml).not.toMatch(/translateX="7"|M7[ ,]2/);
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
        });

        it(`ignores an invalid gradientTransform (optimize: ${optimize})`, () => {
            const { xml } = convert(
                svg(
                    '<linearGradient id="a" gradientUnits="userSpaceOnUse" x1="0" x2="10" gradientTransform="translate(foo 5)">' +
                        '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>' +
                        '<path fill="url(#a)" d="M0 0h20v20z"/>',
                ),
                { optimize },
            );
            expect(xml).toContain('android:startX="0"');
            expect(xml).toContain('android:endX="10"');
        });
    }

    for (const optimize of [true, false]) {
        it(`keeps translate(10 5) (optimize: ${optimize})`, () => {
            const { xml, warnings } = convert(svg('<g transform="translate(10 5)"><path d="M0 0h4v4z"/></g>'), {
                optimize,
            });
            expect(xml).toMatch(/M10[ ,]5|android:translateX="10"\s+android:translateY="5"/);
            expect(warnings).toEqual([]);
        });
    }

    it.each([true, false])('fails in strict mode (optimize: %s)', (optimize) => {
        expect(() =>
            convert(svg('<path transform="translate(foo 5)" d="M0 0h4v4z"/>'), { optimize, strict: true }),
        ).toThrow();
    });
});

describe('skew baked into the geometry', () => {
    // Baking an affine transform into a fill is exact; only a stroke (one uniform width) is approximated.
    const FILLS = {
        'a skewed path': '<path d="M0 0L10 20L20 0z" transform="skewX(30)"/>',
        'a skewed group': '<g transform="skewX(30)"><path d="M0 0L10 20L20 0z"/></g>',
        'a sheared matrix': '<g transform="matrix(1,0,0.5,1,0,0)"><path d="M0 0L0 10L10 10z" fill="#00f"/></g>',
        'an unpainted stroke':
            '<g transform="skewX(30)"><path d="M0 0L10 20L20 0z" stroke="red" stroke-width="0"/></g>',
        'a transparent stroke':
            '<g transform="skewX(30)"><path d="M0 0L10 20L20 0z" stroke="red" stroke-opacity="0"/></g>',
    };
    const STROKES = {
        'a stroke': '<g transform="skewX(30)"><path d="M0 0L10 20" fill="none" stroke="red"/></g>',
        'a dashed stroke':
            '<g transform="skewX(30)"><path d="M0 0L10 20" fill="none" stroke="red" stroke-dasharray="2"/></g>',
        'a skewed stroked path': '<path d="M0 0L10 20" fill="none" stroke="red" transform="skewX(30)"/>',
        'a stroke through <use>':
            '<defs><path id="a" d="M0 0L10 20" fill="none" stroke="red"/></defs><use href="#a" transform="skewX(30)"/>',
        'a stroke among fills':
            '<g transform="skewX(30)"><path d="M0 0h5v5z"/><g><path d="M0 0L10 20" fill="none" stroke="red"/></g></g>',
    };
    for (const optimize of [true, false]) {
        for (const [name, body] of Object.entries(FILLS))
            it(`${name} with fills only: no warning, strict accepted (optimize: ${optimize})`, () => {
                expect(convert(svg(body), { optimize }).warnings).toEqual([]);
                expect(() => convert(svg(body), { optimize, strict: true })).not.toThrow();
            });
        for (const [name, body] of Object.entries(STROKES))
            it(`${name}: group-skew (optimize: ${optimize})`, () => {
                expect(convert(svg(body), { optimize }).warnings.map((w) => w.code)).toEqual(['group-skew']);
            });
    }
});

describe('tiny scale kept with its significant digits', () => {
    // floatPrecision 3 used to round these scales to 0 (or to 0.012) in optimize: false.
    const CASES = {
        'a <g>': '<g transform="scale(0.0004)"><rect width="10000" height="10000" fill="green"/></g>',
        'a translated <g>':
            '<g transform="translate(2 2) scale(0.0004)"><rect width="10000" height="10000" fill="green"/></g>',
        'a <rect>': '<rect transform="scale(0.0004)" width="10000" height="10000" fill="green"/>',
        'a <path>': '<path transform="scale(0.0004)" d="M0 0h10000v10000H0z" fill="green"/>',
        'a <path> under 3 digits': '<path transform="scale(0.0123)" d="M0 0h1000v1000H0z" fill="green"/>',
    };
    for (const optimize of [true, false])
        for (const [name, body] of Object.entries(CASES))
            it(`${name} renders like the source (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(svg(body), { optimize });
                expect(warnings).toEqual([]);
                const result = compareSvgs(svg(body), vdToSvg(xml));
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

    // resvg draws nothing for a 100000-unit rect under scale(0.0001), so the output is checked as text.
    it.each([
        '<g transform="scale(0.0001)"><rect width="100000" height="100000" fill="green"/></g>',
        '<path transform="scale(0.0001)" d="M0 0h100000v100000H0z" fill="green"/>',
    ])('draws the 10×10 square of %s in both modes', (body) => {
        expect(convert(svg(body), { optimize: true }).xml).toContain('android:pathData="M0 0h10v10H0z"');
        const xml = convert(svg(body), { optimize: false }).xml;
        expect(xml).toContain('android:scaleX="0.0001"');
        expect(xml).toContain('android:scaleY="0.0001"');
    });

    it('writes the scale with floatPrecision significant digits (optimize: false)', () => {
        const xml = (s: string, floatPrecision = 3): string =>
            convert(svg(`<path transform="scale(${s})" d="M0 0h4v4z"/>`), { optimize: false, floatPrecision }).xml;
        expect(xml('0.0123456')).toContain('android:scaleX="0.0123"');
        expect(xml('0.333333')).toContain('android:scaleX="0.333"');
        expect(xml('2.123456')).toContain('android:scaleX="2.123"');
        expect(xml('1 -0.0004')).toContain('android:scaleY="-0.0004"');
        expect(xml('0.0004', 0)).toContain('android:scaleX="0.0004"');
    });
});

describe('large scale keeps the decimals of the scaled content', () => {
    // floatPrecision 3 used to round the content to 0.002 / 0.01 under scale(1000) in optimize: false.
    const square = 'M0.0021 0.0021h0.0104v0.0104h-0.0104z';
    const CASES = {
        'a <g>': `<g transform="scale(1000)"><path d="${square}"/></g>`,
        'nested <g>': `<g transform="scale(10)"><g transform="scale(100)"><path d="${square}"/></g></g>`,
        'a <path>': `<path transform="scale(1000)" d="${square}"/>`,
        'a rotated <g>':
            '<g transform="translate(12 12) rotate(30) scale(1000)"><path d="M-0.0052-0.0052h0.0104v0.0104h-0.0104z"/></g>',
    };
    // Shape attributes and the stroke width, which svgo's cleanupNumericValues used to round before
    // the transform in optimize: true.
    const ATTRIBUTES = {
        'a stroke':
            '<g transform="scale(1000)"><path d="M0.0021 0.0121h0.0104" stroke="green" stroke-width="0.0035"/></g>',
        'a <rect> in a <g>':
            '<g transform="scale(1000)"><rect x="0.0021" y="0.0021" width="0.0104" height="0.0104"/></g>',
        'a <rect>': '<rect transform="scale(1000)" x="0.0021" y="0.0021" width="0.0104" height="0.0104"/>',
        'a <circle>': '<circle transform="scale(1000)" cx="0.0121" cy="0.0121" r="0.0051"/>',
    };
    for (const optimize of [true, false])
        for (const [name, body] of Object.entries({ ...CASES, ...ATTRIBUTES }))
            it(`${name} renders like the source (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(svg(body), { optimize });
                expect(warnings).toEqual([]);
                const result = compareSvgs(svg(body), vdToSvg(xml));
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

    it('adds ceil(log10(scale)) decimals to the content only (optimize: false)', () => {
        const pathData = (transform: string): string | undefined =>
            /pathData="([^"]*)"/.exec(
                convert(svg(`<g transform="${transform}"><path d="M0.123456789 1h1z" stroke="#000"/></g>`), {
                    optimize: false,
                }).xml,
            )?.[1];
        expect(pathData('scale(1000)')).toBe('M0.123457 1h1z');
        expect(pathData('scale(10 -100)')).toBe('M0.12346 1h1z');
        expect(pathData('scale(2)')).toBe('M0.1235 1h1z');
        expect(pathData('scale(10)')).toBe('M0.1235 1h1z');
        expect(pathData('scale(10) scale(10)')).toBe('M0.12346 1h1z');
        // A scale of 1 or less keeps floatPrecision.
        expect(pathData('scale(0.5)')).toBe('M0.123 1h1z');
        expect(pathData('rotate(45)')).toBe('M0.123 1h1z');
        // The group's own translation lives in the parent's space.
        expect(
            convert(svg('<g transform="translate(1.23456 0) scale(1000)"><path d="M0 0h1z" stroke="#000"/></g>'), {
                optimize: false,
            }).xml,
        ).toContain('android:translateX="1.235"');
    });

    it('still declares the aapt namespace for a gradient under the scale', () => {
        const body =
            '<defs><linearGradient id="g"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>' +
            '<g transform="scale(10)"><path d="M0 0h2v2H0z" fill="url(#g)"/></g>';
        for (const optimize of [true, false]) expect(convert(svg(body), { optimize }).xml).toContain('xmlns:aapt=');
    });
});

describe('CSS 3D functions that stay in the plane (computed to a 2D matrix by Chrome and Firefox)', () => {
    const expectMatrix = (actual: Matrix | null, expected: Matrix | null, label: string): void => {
        expect(actual, label).not.toBeNull();
        for (const k of Object.keys(IDENTITY) as (keyof Matrix)[])
            expect(actual![k], label).toBeCloseTo(expected![k], 9);
    };
    // [3D form, 2D equivalent]: getComputedStyle in Chrome 156 and Firefox 157 (2026-11).
    const FLAT: [string, string][] = [
        ['translate3d(20px, 20px, 0)', 'translate(20px, 20px)'],
        ['translate3d(1px, 2px, 0px)', 'translate(1px, 2px)'],
        ['translateZ(0)', 'none'],
        ['scale3d(2, 3, 1)', 'scale(2, 3)'],
        ['scaleZ(1)', 'none'],
        ['rotateZ(30deg)', 'rotate(30deg)'],
        ['rotate3d(0, 0, 1, 30deg)', 'rotate(30deg)'],
        ['rotate3d(0, 0, 2, 30deg)', 'rotate(30deg)'],
        ['rotate3d(0, 0, -1, 30deg)', 'rotate(-30deg)'],
        ['rotate3d(0, 0, 0, 30deg)', 'none'],
        ['rotate3d(1, 0, 0, 0deg)', 'none'],
        ['rotateX(0)', 'none'],
        ['rotateY(360deg)', 'none'],
        ['perspective(none)', 'none'],
        ['matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,20,20,0,1)', 'translate(20px, 20px)'],
        ['matrix3d(2,0.5,0,0,0.3,3,0,0,0,0,1,0,4,5,0,1)', 'matrix(2, 0.5, 0.3, 3, 4, 5)'],
        ['translate3d(2px, 3px, 0) rotateZ(90deg) scale3d(2, 2, 1)', 'translate(2px, 3px) rotate(90deg) scale(2)'],
    ];
    // Computed to a matrix3d by both browsers: real 3D, not foldable.
    const DEEP = [
        'rotateX(10deg)',
        'rotateY(10deg)',
        'rotate3d(1, 0, 0, 10deg)',
        'translateZ(5px)',
        'translate3d(1px, 2px, 3px)',
        'scaleZ(2)',
        'scale3d(1, 1, 2)',
        'perspective(100px)',
        'matrix3d(1,0,0,0,0,1,0,0,0,0,2,0,0,0,0,1)',
        'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,2)',
        'translate(1px, 1px) rotateX(10deg)',
    ];

    it.each(FLAT)('parseCssTransform(%s) is %s', (value, flat) => {
        expectMatrix(parseCssTransform(value), parseCssTransform(flat), value);
    });

    it.each(DEEP)('parseCssTransform(%s) is null (real 3D)', (value) => {
        expect(parseCssTransform(value)).toBeNull();
    });

    const shape =
        '<rect x="2" y="2" width="6" height="4" fill="#f00"/><rect x="9" y="3" width="3" height="5" fill="#00f"/>';
    const onElement = (value: string): string => svg(`<g style="transform: ${value}">${shape}</g>`);
    const onRoot = (value: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" style="transform: ${value}">${shape}</svg>`;

    for (const optimize of [true, false])
        for (const [where, doc] of [
            ['element', onElement],
            ['root', onRoot],
        ] as const) {
            it.each(FLAT)(
                `on the ${where}, %s converts as %s, no warning, strict accepted (optimize: ${optimize})`,
                (value, flat) => {
                    const expected = convert(doc(flat), { optimize, strict: true });
                    const actual = convert(doc(value), { optimize, strict: true });
                    expect(actual.warnings).toEqual([]);
                    expect(actual.xml).toBe(expected.xml);
                },
            );

            it.each(['rotateX(10deg)', 'matrix3d(1,0,0,0,0,1,0,0,0,0,2,0,0,0,0,1)'])(
                `on the ${where}, %s keeps its warning (optimize: ${optimize})`,
                (value) => {
                    expect(convert(doc(value), { optimize }).warnings.map((w) => w.code)).toEqual([
                        'unsupported-style',
                    ]);
                    expect(() => convert(doc(value), { optimize, strict: true })).toThrow();
                },
            );
        }
});

describe('parseCssTransform arguments are comma-separated (as in CSS, unlike the attribute)', () => {
    it.each([
        'translate(1px 2px)',
        'scale(2 3)',
        'matrix(1 0 0 1 0 0)',
        'translate3d(1px 2px 0)',
        'translate(1px,,2px)',
        'translate(1px,)',
        'rotate()',
    ])('rejects %s', (value) => {
        expect(parseCssTransform(value)).toBeNull();
    });

    it('still reads spaces around the commas', () => {
        expect(parseCssTransform(' translate( 1px , 2px ) ')).toEqual({ ...IDENTITY, e: 1, f: 2 });
    });
});
