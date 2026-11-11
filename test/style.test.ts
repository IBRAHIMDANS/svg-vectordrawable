import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from 'svgo';
import { convert } from '../src/index.js';
import type { XastElement } from '../src/ast.js';
import { applyCssProperties } from '../src/style.js';
import { IDENTITY, parseCssTransform, parseTransform, parseTransformOrigin, type Matrix } from '../src/transform.js';
import { WARNING_CATEGORIES, type Warning } from '../src/types.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';
import { vdToSvg } from './visual/vdToSvg.js';

const repro = (file: string): string =>
    readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'wpt-repro', file), 'utf8');

const expectMatrix = (actual: Matrix | null, expected: Matrix): void => {
    expect(actual).not.toBeNull();
    for (const k of Object.keys(expected) as (keyof Matrix)[]) expect(actual![k]).toBeCloseTo(expected[k], 9);
};

describe('parseCssTransform', () => {
    it('parses 2D functions with CSS units and commas', () => {
        expectMatrix(parseCssTransform('scale(2, 3)'), { ...IDENTITY, a: 2, d: 3 });
        expectMatrix(parseCssTransform('scale(50%)'), { ...IDENTITY, a: 0.5, d: 0.5 });
        expectMatrix(parseCssTransform('translate(10px, 1in)'), { ...IDENTITY, e: 10, f: 96 });
        expectMatrix(parseCssTransform('translateX(5px) translateY(-2)'), { ...IDENTITY, e: 5, f: -2 });
        expectMatrix(parseCssTransform('scaleX(2) scaleY(4)'), { ...IDENTITY, a: 2, d: 4 });
        expectMatrix(parseCssTransform('matrix(1, 2, 3, 4, 5, 6)'), { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
        expectMatrix(parseCssTransform('skew(45deg)'), { ...IDENTITY, c: 1 });
        expectMatrix(parseCssTransform('skewY(45deg)'), { ...IDENTITY, b: 1 });
    });

    it('reads every angle unit (a bare number is in degrees, as in SVG)', () => {
        const quarter = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };
        for (const angle of ['90deg', '90', '0.25turn', '100grad', `${Math.PI / 2}rad`])
            expectMatrix(parseCssTransform(`rotate(${angle})`), quarter);
    });

    it('composes functions left to right, like the attribute', () => {
        expectMatrix(parseCssTransform('translate(10px, 20px) scale(2)'), parseTransform('translate(10 20) scale(2)')!);
    });

    it('reads none as the identity', () => {
        expect(parseCssTransform(' none ')).toEqual(IDENTITY);
    });

    it('returns null for what no 2D matrix with absolute units expresses', () => {
        for (const v of [
            'translate(50%)', // percentage of the reference box
            'translate(1em)',
            'rotateX(10deg)',
            'translate3d(1px, 2px, 0)',
            'scale(calc(1 + 1))',
            'scale(var(--k))',
            'rotate(45deg, 10px, 10px)', // SVG-only syntax: invalid CSS
            'scale(2) junk',
            'matrix(1, 0, 0, 1, 0)',
            '',
        ])
            expect(parseCssTransform(v), v).toBeNull();
    });
});

describe('parseTransformOrigin', () => {
    it('parses absolute lengths and zero keywords, in either order', () => {
        expect(parseTransformOrigin('10px 20px')).toEqual({ x: 10, y: 20 });
        expect(parseTransformOrigin('1in 0')).toEqual({ x: 96, y: 0 });
        expect(parseTransformOrigin('0 0 4px')).toEqual({ x: 0, y: 0 });
        expect(parseTransformOrigin('left top')).toEqual({ x: 0, y: 0 });
        expect(parseTransformOrigin('top left')).toEqual({ x: 0, y: 0 });
        expect(parseTransformOrigin('0% 5')).toEqual({ x: 0, y: 5 });
    });

    it('returns null for components that depend on the reference box', () => {
        for (const v of ['50% 50%', 'center', 'left', '0', 'right 0', '10px bottom', '1em 0', 'top top', '1 2 3 4'])
            expect(parseTransformOrigin(v), v).toBeNull();
    });
});

/** Runs `applyCssProperties` on `<svg>…body…</svg>` and returns its first child plus the warnings. */
function fold(body: string, rootAttrs = ''): { el: XastElement; root: XastElement; warnings: Warning[] } {
    const warnings: Warning[] = [];
    let captured: XastElement | undefined;
    const capture = {
        name: 'capture',
        fn: (root: XastElement) => {
            applyCssProperties(root, (w) => warnings.push(w));
            captured = root;
            return {};
        },
    };
    // svgo is only the parser here (no optimization plugin), as in parseSvg with optimize: false.
    convert(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${rootAttrs}>${body}</svg>`, {
        svgoConfig: { plugins: [capture] } as unknown as Config,
    });
    const svg = captured!.children!.find((c) => c.name === 'svg')!;
    return { el: svg.children!.find((c) => c.type === 'element')!, root: svg, warnings };
}

describe('applyCssProperties: transform', () => {
    it('folds the CSS transform into the attribute, which it overrides', () => {
        const { el, warnings } = fold(
            '<rect width="4" height="4" transform="translate(9 9)" style="transform: scale(2, 3); fill: red"/>',
        );
        expectMatrix(parseTransform(el.attributes!.transform), { ...IDENTITY, a: 2, d: 3 });
        expect(el.attributes!.style).toBe('fill:red');
        expect(warnings).toEqual([]);
    });

    it('applies transform-origin (attribute or CSS) to the attribute transform', () => {
        const expected = parseTransform('rotate(90 10 5)')!;
        const attr = fold('<rect width="4" height="4" transform="rotate(90)" transform-origin="10 5"/>');
        expectMatrix(parseTransform(attr.el.attributes!.transform), expected);
        expect(attr.el.attributes!['transform-origin']).toBeUndefined();
        const css = fold('<rect width="4" height="4" transform="rotate(90)" style="transform-origin: 10px 5px"/>');
        expectMatrix(parseTransform(css.el.attributes!.transform), expected);
        expect(css.el.attributes!.style).toBeUndefined();
    });

    it('applies transform-origin to the CSS transform, with transform-box: view-box', () => {
        const { el, warnings } = fold(
            '<g style="transform: rotate(90deg); transform-origin: 10px 5px; transform-box: view-box"><path d="M0 0h1v1z"/></g>',
        );
        expectMatrix(parseTransform(el.attributes!.transform), parseTransform('rotate(90 10 5)')!);
        expect(warnings).toEqual([]);
    });

    it('leaves the attribute untouched when nothing CSS changes it', () => {
        const { el } = fold('<rect width="4" height="4" transform="rotate(30)" style="transform-origin: 0 0"/>');
        expect(el.attributes!.transform).toBe('rotate(30)');
    });

    it('drops the attribute transform under transform: none', () => {
        const { el } = fold('<rect width="4" height="4" transform="scale(2)" style="transform: none"/>');
        expect(el.attributes!.transform).toBeUndefined();
    });

    it('reports what no matrix expresses and leaves the element as it was', () => {
        for (const style of [
            'transform: translate(50%)',
            'transform: rotate(45deg); transform-origin: center',
            'transform: rotate(45deg); transform-box: fill-box',
        ]) {
            const body = `<rect width="4" height="4" transform="scale(2)" style="${style}"/>`;
            const { el, warnings } = fold(body);
            expect(
                warnings.map((w) => [w.code, w.node]),
                style,
            ).toEqual([['unsupported-style', 'rect']]);
            expect(el.attributes!.transform).toBe('scale(2)');
            expect(el.attributes!.style).toBe(style);
        }
    });

    it('ignores transform-box and transform-origin when nothing is transformed', () => {
        const { warnings } = fold(
            '<rect width="4" height="4" style="transform-box: fill-box; transform-origin: 50% 50%"/>',
        );
        expect(warnings).toEqual([]);
    });

    it('leaves the root <svg> transform to convert.ts (its default origin is the centre of its box)', () => {
        const { root, warnings } = fold('<rect width="4" height="4"/>', ' style="transform: scale(2)"');
        expect(warnings).toEqual([]);
        expect(root.attributes!.transform).toBeUndefined();
        expect(root.attributes!.style).toBe('transform: scale(2)');
    });

    it('leaves gradients alone (gradientTransform positions them)', () => {
        const { el } = fold('<linearGradient id="g" style="transform: scale(2)"/>');
        expect(el.attributes!.transform).toBeUndefined();
    });
});

describe('applyCssProperties: mix-blend-mode', () => {
    it('reports any blend mode but normal as unsupported-style (lossy: strict rejects it)', () => {
        const { warnings } = fold('<rect width="4" height="4" style="mix-blend-mode: Screen"/>');
        expect(warnings).toEqual([
            {
                code: 'unsupported-style',
                message: 'mix-blend-mode: screen on <rect> cannot be represented in a VectorDrawable; ignored.',
                node: 'rect',
            },
        ]);
        expect(WARNING_CATEGORIES['unsupported-style']).toBe('lossy');
        expect(fold('<rect width="4" height="4" style="mix-blend-mode: normal"/>').warnings).toEqual([]);
    });
});

/** svgo's preset as `parseSvg` configures it (src/normalize.ts DEFAULT_OVERRIDES). */
const PRESET_OVERRIDES = {
    inlineStyles: { onlyMatchedOnce: false },
    convertShapeToPath: { convertArcs: true },
    convertPathData: { convertToQ: false },
    cleanupIds: { remove: false },
};

/**
 * `convert` with `applyCssProperties` run right after parsing (where `src/convert.ts` is to call
 * it): an svgo plugin placed after the preset (`optimize: true`) or alone (`optimize: false`).
 */
function convertWithCss(svg: string, optimize: boolean, overrides: Record<string, unknown> = {}) {
    const warnings: Warning[] = [];
    const css = {
        name: 'apply-css-properties',
        fn: (root: XastElement) => {
            applyCssProperties(root, (w) => warnings.push(w));
            return {};
        },
    };
    const preset = { name: 'preset-default', params: { overrides: { ...PRESET_OVERRIDES, ...overrides } } };
    const result = convert(svg, { svgoConfig: { plugins: optimize ? [preset, css] : [css] } as unknown as Config });
    return { xml: result.xml, warnings: [...warnings, ...result.warnings] };
}

/**
 * The preset change `src/normalize.ts` needs when the source uses a CSS transform or
 * `transform-origin`: svgo moves group transforms between parent and children and bakes `transform`
 * into path data without reading the CSS `transform` nor `transform-origin`, and drops
 * `transform-origin` from groups.
 */
const KEEP_TRANSFORMS = {
    moveElemsAttrsToGroup: false,
    moveGroupAttrsToElems: false,
    collapseGroups: false,
    removeNonInheritableGroupAttrs: false,
    convertPathData: { ...PRESET_OVERRIDES.convertPathData, applyTransforms: false },
};

const codes = (warnings: Warning[]): string[] => warnings.map((w) => w.code).filter((c) => c !== 'large-vector');

describe('wpt-repro: CSS transform', () => {
    const svg = repro('wpt-css-transform-property.svg');
    // What the browser draws: the CSS scale, inside the group's translation.
    const reference = svg.replace('style="transform: scale(2, 3)"', 'transform="scale(2 3)"');
    const asStyleRule = svg
        .replace('style="transform: scale(2, 3)"', 'class="k"')
        .replace('</svg>', '<style>.k { transform: scale(2, 3) }</style></svg>');

    it('the reference differs from the unscaled rendering', () => {
        const unscaled = svg.replace('style="transform: scale(2, 3)"', '');
        expect(compareSvgs(reference, unscaled).mismatch).toBeGreaterThan(0.3);
    });

    it('renders like the source with optimize: false', () => {
        const { xml, warnings } = convertWithCss(svg, false);
        expect(codes(warnings)).toEqual([]);
        expect(compareSvgs(reference, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
    });

    for (const [label, source] of [
        ['style attribute', svg],
        ['<style> rule', asStyleRule],
    ] as const)
        it(`renders like the source with optimize: true and the KEEP_TRANSFORMS preset change (${label})`, () => {
            const { xml, warnings } = convertWithCss(source, true, KEEP_TRANSFORMS);
            expect(codes(warnings)).toEqual([]);
            expect(compareSvgs(reference, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        });

    it("svgo's preset as it is collapses the group transform onto the element: wrong with optimize: true", () => {
        const { xml } = convertWithCss(svg, true);
        expect(compareSvgs(reference, vdToSvg(xml)).mismatch).toBeGreaterThan(0.5);
    });

    // resvg ignores `transform-origin`: the references spell the origin out in the transform instead.
    const rotated = (attrs: string, child = ''): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><g ${attrs}><path fill="blue" d="M5 0h10v4H5z"/>${child}</g></svg>`;
    const second = '<path fill="red" d="M5 10h10v4H5z"/>';
    for (const [label, source, expected] of [
        [
            'transform-origin attribute on a group',
            rotated('transform="rotate(90)" transform-origin="20 20"', second),
            rotated('transform="rotate(90 20 20)"', second),
        ],
        [
            'CSS transform-origin on a path',
            rotated('').replace('<path', '<path transform="rotate(90)" style="transform-origin: 20px 20px"'),
            rotated('transform="rotate(90 20 20)"'),
        ],
    ] as const)
        it(`applies ${label} with both optimize settings`, () => {
            for (const optimize of [false, true]) {
                const { xml, warnings } = convertWithCss(source, optimize, KEEP_TRANSFORMS);
                expect(codes(warnings)).toEqual([]);
                expect(compareSvgs(expected, vdToSvg(xml)).mismatch, `optimize: ${optimize}`).toBeLessThan(
                    DEFAULT_MAX_MISMATCH,
                );
            }
        });

    it('transform-origin and a <use> CSS transform reach the expanded clone', () => {
        const source =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><rect id="r" width="10" height="4" fill="blue"/></defs>' +
            '<use href="#r" x="5" style="transform: rotate(90deg); transform-origin: 20px 20px"/></svg>';
        const expected =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
            '<rect transform="rotate(90 20 20) translate(5 0)" width="10" height="4" fill="blue"/></svg>';
        for (const optimize of [false, true]) {
            const { xml, warnings } = convertWithCss(source, optimize, KEEP_TRANSFORMS);
            expect(codes(warnings)).toEqual([]);
            expect(compareSvgs(expected, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        }
    });
});

describe('wpt-repro: mix-blend-mode', () => {
    const svg = repro('wpt-mix-blend-mode.svg');

    it('is reported as unsupported-style with both optimize settings', () => {
        for (const optimize of [false, true])
            expect(codes(convertWithCss(svg, optimize).warnings), `optimize: ${optimize}`).toEqual([
                'unsupported-style',
            ]);
    });
});
