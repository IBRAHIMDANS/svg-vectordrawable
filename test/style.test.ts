import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { optimize as svgoOptimize } from 'svgo';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, ConversionError } from '../src/index.js';
import type { XastElement } from '../src/ast.js';
import { parseSvg } from '../src/normalize.js';
import {
    applyCssProperties,
    cssComponents,
    cssListItems,
    cssPathString,
    isValidPropertyValue,
    parseStyle,
    styleDeclarations,
} from '../src/style.js';
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
            'translate(1ex)',
            'rotateX(10deg)',
            'translate3d(1px, 2px, 3px)',
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
        for (const v of ['50% 50%', 'center', 'left', '0', 'right 0', '10px bottom', '1ex 0', 'top top', '1 2 3 4'])
            expect(parseTransformOrigin(v), v).toBeNull();
    });
});

/** Runs `applyCssProperties` on `<svg>…body…</svg>` and returns its first child plus the warnings. */
function fold(body: string, rootAttrs = ''): { el: XastElement; root: XastElement; warnings: Warning[] } {
    const warnings: Warning[] = [];
    // svgo is only the parser here (no optimization plugin), as with optimize: false.
    const root = parseSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"${rootAttrs}>${body}</svg>`,
        false,
    );
    applyCssProperties(root, (w) => warnings.push(w));
    const svg = root.children.find((c) => c.name === 'svg')!;
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
            'transform: rotate(45deg); transform-origin: 1ex 0',
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

    it('resolves transform-origin keywords and percentages on the viewport (transform-box: view-box)', () => {
        // Chrome: on the viewBox size, from the user-space origin (not the viewBox's minX / minY).
        for (const style of ['transform-origin: center', 'transform-origin: 50% 50%; transform-box: view-box']) {
            const { el, warnings } = fold(`<rect width="4" height="4" style="transform: scale(2); ${style}"/>`);
            expect(warnings, style).toEqual([]);
            expectMatrix(
                parseTransform(el.attributes!.transform),
                parseTransform('translate(12 12) scale(2) translate(-12 -12)')!,
            );
        }
        const offset = fold(
            '<rect width="4" height="4" style="transform: scale(2); transform-origin: 50% 25%"/>',
            ' viewBox="10 10 24 40"',
        );
        expect(offset.warnings).toEqual([]);
        expectMatrix(
            parseTransform(offset.el.attributes!.transform),
            parseTransform('translate(12 10) scale(2) translate(-12 -10)')!,
        );
    });

    it('resolves the viewport of a nested <svg>, not that of <symbol> content', () => {
        const nested = fold(
            '<svg width="10" height="10" viewBox="0 0 100 100"><rect width="4" height="4" style="transform: scale(2); transform-origin: 50% 50%"/></svg>',
        );
        expect(nested.warnings).toEqual([]);
        const rect = nested.el.children!.find((c) => c.type === 'element')!;
        expectMatrix(
            parseTransform(rect.attributes!.transform),
            parseTransform('translate(50 50) scale(2) translate(-50 -50)')!,
        );
        const symbol = fold(
            '<symbol id="s" viewBox="0 0 100 100"><rect width="4" height="4" style="transform: scale(2); transform-origin: 50% 50%"/></symbol><use href="#s"/>',
        );
        expect(symbol.warnings.map((w) => [w.code, w.node])).toEqual([['unsupported-style', 'rect']]);
    });

    it('reports transform-origin percentages under an unsized root (no viewBox, no size)', () => {
        const root = parseSvg(
            '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4" style="transform: scale(2); transform-origin: 50% 50%"/></svg>',
            false,
        );
        const warnings: Warning[] = [];
        applyCssProperties(root, (w) => warnings.push(w));
        expect(warnings.map((w) => [w.code, w.node])).toEqual([['unsupported-style', 'rect']]);
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

    it('folds a gradient CSS transform into gradientTransform, which it overrides (not transform)', () => {
        const { el, warnings } = fold(
            '<linearGradient id="g" gradientTransform="scale(3)" style="transform: rotate(90deg); transform-origin: 0.5px 0.5px"/>',
        );
        expectMatrix(parseTransform(el.attributes!.gradientTransform), parseTransform('rotate(90 0.5 0.5)')!);
        expect(el.attributes!.transform).toBeUndefined();
        expect(el.attributes!.style).toBeUndefined();
        expect(warnings).toEqual([]);
    });

    it('applies a gradient transform-origin attribute to its gradientTransform (as Chrome does)', () => {
        const { el } = fold('<radialGradient id="g" gradientTransform="rotate(45)" transform-origin="0.5 0.5"/>');
        expectMatrix(parseTransform(el.attributes!.gradientTransform), parseTransform('rotate(45 0.5 0.5)')!);
        expect(el.attributes!['transform-origin']).toBeUndefined();
    });

    it('drops gradientTransform under transform: none (a template one is then inherited, as in Chrome)', () => {
        const { el } = fold('<linearGradient id="g" gradientTransform="rotate(90)" style="transform: none"/>');
        expect(el.attributes!.gradientTransform).toBeUndefined();
    });

    it('leaves patterns alone', () => {
        const { el } = fold('<pattern id="p" style="transform: scale(2)"/>');
        expect(el.attributes!.transform).toBeUndefined();
        expect(el.attributes!.patternTransform).toBeUndefined();
    });
});

describe('CSS transform on a gradient (Chrome: same as gradientTransform)', () => {
    const STOPS = '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>';
    const doc = (gradient: string, extra = ''): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${extra}<defs>${gradient}</defs><rect width="24" height="24" fill="url(#g)"/></svg>`;
    const linear = (attrs: string): string => doc(`<linearGradient id="g" ${attrs}>${STOPS}</linearGradient>`);
    const radial = (attrs: string): string => doc(`<radialGradient id="g" r="0.3" ${attrs}>${STOPS}</radialGradient>`);
    // A sharp red / blue edge at x = 6 (before the transform): a shift of a few units shows.
    const userSpace = (attrs: string): string =>
        doc(
            `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" x2="24" ${attrs}>` +
                '<stop offset="0.2" stop-color="red"/><stop offset="0.3" stop-color="blue"/></linearGradient>',
        );
    // Each pair renders identically in Chrome 157 (checked pixel by pixel); the reference is the attribute.
    const cases: [string, string, string][] = [
        ['linear rotate(90deg)', linear('style="transform: rotate(90deg)"'), linear('gradientTransform="rotate(90)"')],
        [
            'linear rotate + transform-origin',
            linear('style="transform: rotate(45deg); transform-origin: 0.5px 0.5px"'),
            linear('gradientTransform="rotate(45 0.5 0.5)"'),
        ],
        [
            'linear CSS over the attribute',
            linear('gradientTransform="rotate(90)" style="transform: rotate(45deg)"'),
            linear('gradientTransform="rotate(45)"'),
        ],
        ['linear rotate: 90deg', linear('style="rotate: 90deg"'), linear('gradientTransform="rotate(90)"')],
        ['radial rotate(90deg)', radial('style="transform: rotate(90deg)"'), radial('gradientTransform="rotate(90)"')],
        [
            'radial translate + scale',
            radial('style="transform: translate(0.25px, 0.1px) scale(0.5)"'),
            radial('gradientTransform="translate(0.25 0.1) scale(0.5)"'),
        ],
        [
            'userSpaceOnUse rotate around 12px 12px',
            linear(
                'gradientUnits="userSpaceOnUse" x1="0" x2="24" style="transform: rotate(90deg); transform-origin: 12px 12px"',
            ),
            linear('gradientUnits="userSpaceOnUse" x1="0" x2="24" gradientTransform="rotate(90 12 12)"'),
        ],
        [
            'a CSS transform inherited from an href template',
            doc(
                `<linearGradient id="t" style="transform: rotate(90deg)">${STOPS}</linearGradient><linearGradient id="g" href="#t"/>`,
            ),
            linear('gradientTransform="rotate(90)"'),
        ],
        [
            'transform: none over the attribute',
            linear('gradientTransform="rotate(90)" style="transform: none"'),
            linear(''),
        ],
        // Chrome 2026-11 (checked pixel by pixel): `view-box` is the 24×24 viewport, even for an
        // objectBoundingBox gradient (the origin then lands in its bounding-box units); a geometry
        // box of a gradient, which draws nothing, is empty at the origin.
        [
            'userSpaceOnUse scale(0.5) around 50% 50% (view-box)',
            userSpace(`style="transform: scale(0.5); transform-origin: 50% 50%"`),
            userSpace(`gradientTransform="translate(12 12) scale(0.5) translate(-12 -12)"`),
        ],
        [
            'objectBoundingBox rotate(45deg) around 50% 50% (view-box)',
            linear('style="transform: rotate(45deg); transform-origin: 50% 50%"'),
            linear('gradientTransform="rotate(45 12 12)"'),
        ],
        [
            'userSpaceOnUse scale(0.5), transform-box: fill-box',
            userSpace(`style="transform: scale(0.5); transform-origin: 50% 50%; transform-box: fill-box"`),
            userSpace(`gradientTransform="scale(0.5)"`),
        ],
        [
            'userSpaceOnUse scale(0.5), transform-box: stroke-box, origin 24px 0',
            userSpace(`style="transform: scale(0.5); transform-origin: 24px 0; transform-box: stroke-box"`),
            userSpace(`gradientTransform="translate(24 0) scale(0.5) translate(-24 0)"`),
        ],
    ];

    it('the references differ from the untransformed rendering', () => {
        for (const [label, , reference] of cases.slice(0, 7)) {
            const untransformed = label.startsWith('radial') ? radial('') : linear('');
            expect(compareSvgs(reference, untransformed).mismatch, label).toBeGreaterThan(0.1);
        }
        // The reference-box cases: each origin changes the rendering.
        const scaled = [
            `translate(12 12) scale(0.5) translate(-12 -12)`,
            'scale(0.5)',
            'translate(24 0) scale(0.5) translate(-24 0)',
        ];
        for (const [i, a] of scaled.entries())
            for (const b of [...scaled.slice(i + 1), ''])
                expect(
                    compareSvgs(userSpace(`gradientTransform="${a}"`), userSpace(`gradientTransform="${b}"`)).mismatch,
                    `${a} / ${b}`,
                ).toBeGreaterThan(0.1);
    });

    for (const optimize of MODES)
        for (const [label, source, reference] of cases)
            it(`${label} renders like Chrome under strict (optimize: ${optimize})`, () => {
                const result = compareSvgs(reference, vdToSvg(convert(source, { optimize, strict: true }).xml));
                expect(result.inked).toBeGreaterThan(0);
                expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

    it('a <style> rule on a gradient, inlined by svgo (optimize: true), renders like Chrome', () => {
        const source = doc(
            `<linearGradient id="g" class="v">${STOPS}</linearGradient>`,
            '<style>.v{transform:rotate(90deg)}</style>',
        );
        const xml = convert(source, { optimize: true, strict: true }).xml;
        expect(compareSvgs(linear('gradientTransform="rotate(90)"'), vdToSvg(xml)).mismatch).toBeLessThan(
            DEFAULT_MAX_MISMATCH,
        );
    });

    for (const optimize of MODES)
        for (const style of [
            'transform: rotate(45deg); transform-origin: 1ex 0',
            'transform: translateX(50%)',
            'transform: rotate(45deg); transform-box: nonsense',
        ])
            it(`reports ${style} (not resolvable) and strict rejects it (optimize: ${optimize})`, () => {
                const source = linear(`style="${style}"`);
                expect(convert(source, { optimize }).warnings).toEqual([
                    expect.objectContaining({ code: 'unsupported-style', node: 'linearGradient' }),
                ]);
                const error = conversionError(() => convert(source, { optimize, strict: true }));
                expect(error.warning.code).toBe('unsupported-style');
            });

    it('does not report an unreferenced gradient', () => {
        const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="u" style="transform: translate(50%)">${STOPS}</linearGradient></defs><rect width="2" height="2"/></svg>`;
        for (const optimize of MODES) expect(convert(source, { optimize, strict: true }).warnings).toEqual([]);
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

describe('applyCssProperties: path-length', () => {
    it('reports the CSS property (tentative) as unsupported-style, not the attribute', () => {
        expect(fold('<rect width="4" height="4" style="path-length: 10px"/>').warnings).toEqual([
            {
                code: 'unsupported-style',
                message: 'path-length: 10px on <rect> is not supported (only the pathLength attribute); ignored.',
                node: 'rect',
            },
        ]);
        expect(fold('<rect width="4" height="4" style="path-length: none"/>').warnings).toEqual([]);
        expect(fold('<rect width="4" height="4" pathLength="10"/>').warnings).toEqual([]);
    });
});

const codes = (warnings: Warning[]): string[] => warnings.map((w) => w.code).filter((c) => c !== 'large-vector');

/** The `ConversionError` thrown by `run`, or a failure when it converts. */
function conversionError(run: () => unknown): ConversionError {
    try {
        run();
    } catch (err) {
        if (err instanceof ConversionError) return err;
        throw err;
    }
    throw new Error('expected a ConversionError');
}

const MODES = [false, true] as const;

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

    for (const optimize of MODES)
        it(`renders like the source under strict (optimize: ${optimize}, style attribute)`, () => {
            const { xml, warnings } = convert(svg, { optimize, strict: true });
            expect(codes(warnings)).toEqual([]);
            expect(compareSvgs(reference, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        });

    it('renders like the source under strict (optimize: true, <style> rule inlined by svgo)', () => {
        const { xml, warnings } = convert(asStyleRule, { strict: true });
        expect(codes(warnings)).toEqual([]);
        expect(compareSvgs(reference, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
    });

    it('a <style> rule is not inlined with optimize: false: strict rejects it', () => {
        const error = conversionError(() => convert(asStyleRule, { optimize: false, strict: true }));
        expect(error.warning.code).toBe('unsupported-style');
    });

    it("svgo's preset without the normalize.ts change collapses the group transform: wrong", () => {
        const { xml } = convert(svg, { svgoConfig: { plugins: ['preset-default'] } });
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
        [
            'CSS transform and transform-origin on a group',
            rotated('style="transform: rotate(90deg); transform-origin: 20px 20px"', second),
            rotated('transform="rotate(90 20 20)"', second),
        ],
    ] as const)
        for (const optimize of MODES)
            it(`applies ${label} under strict (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(source, { optimize, strict: true });
                expect(codes(warnings)).toEqual([]);
                expect(compareSvgs(expected, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

    for (const optimize of MODES)
        it(`transform-origin and a <use> CSS transform reach the expanded clone (optimize: ${optimize})`, () => {
            const source =
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><rect id="r" width="10" height="4" fill="blue"/></defs>' +
                '<use href="#r" x="5" style="transform: rotate(90deg); transform-origin: 20px 20px"/></svg>';
            const expected =
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
                '<rect transform="rotate(90 20 20) translate(5 0)" width="10" height="4" fill="blue"/></svg>';
            const { xml, warnings } = convert(source, { optimize, strict: true });
            expect(codes(warnings)).toEqual([]);
            expect(compareSvgs(expected, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        });

    for (const optimize of MODES)
        it(`strict rejects transform-box: fill-box (optimize: ${optimize})`, () => {
            const source = rotated('style="transform: rotate(90deg); transform-box: fill-box"');
            const error = conversionError(() => convert(source, { optimize, strict: true }));
            expect([error.warning.code, error.warning.node]).toEqual(['unsupported-style', 'g']);
        });

    for (const optimize of MODES)
        it(`reports an unresolved CSS transform on the root <svg> once (optimize: ${optimize})`, () => {
            const source =
                '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" style="transform: translate(50%)"><rect width="4" height="4"/></svg>';
            const { warnings } = convert(source, { optimize });
            expect(warnings.map((w) => [w.code, w.node])).toEqual([['unsupported-style', 'svg']]);
        });
});

describe('wpt-repro: mix-blend-mode', () => {
    const svg = repro('wpt-mix-blend-mode.svg');

    for (const optimize of MODES) {
        it(`is reported as unsupported-style (optimize: ${optimize})`, () => {
            expect(codes(convert(svg, { optimize }).warnings)).toEqual(['unsupported-style']);
        });

        it(`is rejected under strict (optimize: ${optimize})`, () => {
            const error = conversionError(() => convert(svg, { optimize, strict: true }));
            // optimize: true reports the <path> svgo turned the <rect> into.
            expect(error.warning.code).toBe('unsupported-style');
        });
    }
});

describe('CSS path-length (wpt path-length-css-*, tentative)', () => {
    const dashed = (attrs: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect x="20" y="20" width="200" height="200" fill="none" stroke="#000" stroke-width="5" stroke-dasharray="0.25" ${attrs}/></svg>`;

    for (const optimize of MODES) {
        it(`a style attribute is rejected under strict (optimize: ${optimize})`, () => {
            const error = conversionError(() =>
                convert(dashed('style="path-length: 10px"'), { optimize, strict: true }),
            );
            expect(error.warning.code).toBe('unsupported-style');
        });

        it(`a <style> rule is rejected under strict (optimize: ${optimize})`, () => {
            const source = dashed('').replace('</svg>', '<style>rect { path-length: 10px }</style></svg>');
            const error = conversionError(() => convert(source, { optimize, strict: true }));
            expect(error.warning.code).toBe('unsupported-style');
        });
    }
});

describe('individual transforms (translate / rotate / scale)', () => {
    const doc = (attrs: string, child = ''): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><g ${attrs}><path fill="blue" d="M5 0h10v4H5z"/>${child}</g></svg>`;
    const second = '<path fill="red" d="M5 10h10v4H5z"/>';
    // resvg reads neither these properties nor `transform-origin`: the references spell them out.
    for (const [label, source, expected] of [
        ['translate', doc('style="translate: 10px 5px"', second), doc('transform="translate(10 5)"', second)],
        ['rotate', doc('style="rotate: 90deg"', second), doc('transform="rotate(90)"', second)],
        ['scale', doc('style="scale: 2 50%"', second), doc('transform="scale(2 0.5)"', second)],
        [
            'rotate around transform-origin',
            doc('style="rotate: 90deg; transform-origin: 20px 20px"', second),
            doc('transform="rotate(90 20 20)"', second),
        ],
        [
            'all three, before transform, around transform-origin',
            doc(
                'style="scale: 1.5; transform: translate(1px, 2px); rotate: 30deg; translate: 10px; transform-origin: 5px 5px"',
                second,
            ),
            doc(
                'transform="translate(5 5) translate(10 0) rotate(30) scale(1.5) translate(1 2) translate(-5 -5)"',
                second,
            ),
        ],
        [
            'before the transform attribute',
            doc('transform="translate(3 4)" style="rotate: 45deg"', second),
            doc('transform="rotate(45) translate(3 4)"', second),
        ],
        [
            '3D syntax that stays 2D',
            doc('style="translate: 1px 2px 0; rotate: z 90deg; scale: 2 2 1"', second),
            doc('transform="translate(1 2) rotate(90) scale(2)"', second),
        ],
        [
            'rotate around a numeric z axis (opposite for a negative one)',
            doc(
                'style="rotate: 0 0 1 10deg; translate: 0 -10px"',
                '<path style="rotate: 30deg 0 0 -2" fill="red" d="M5 10h10v4H5z"/>',
            ),
            doc(
                'transform="translate(0 -10) rotate(10)"',
                '<path transform="rotate(-30)" fill="red" d="M5 10h10v4H5z"/>',
            ),
        ],
        [
            'scale with a negative component (svgo writes `scale:2-1`)',
            doc('style="scale: 2 -1; translate: 0 20px"', second),
            doc('transform="translate(0 20) scale(2 -1)"', second),
        ],
        [
            'on paths inside a transformed group (svgo must not move the group transform onto them)',
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><g transform="translate(20 0)">' +
                '<path style="rotate: 90deg" fill="blue" d="M5 0h10v4H5z"/><path style="rotate: 90deg" fill="red" d="M5 10h10v4H5z"/></g></svg>',
            doc('transform="translate(20 0) rotate(90)"', second),
        ],
        [
            'on a path',
            doc('').replace('<path', '<path style="translate: 5px 10px"'),
            doc('transform="translate(5 10)"'),
        ],
    ] as const)
        for (const optimize of MODES)
            it(`applies ${label} under strict (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(source, { optimize, strict: true });
                expect(codes(warnings)).toEqual([]);
                expect(compareSvgs(expected, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

    it('the references differ from the untransformed rendering', () => {
        expect(compareSvgs(doc('', second), doc('transform="translate(10 5)"', second)).mismatch).toBeGreaterThan(0.1);
    });

    for (const value of ['none', 'initial', 'unset', 'revert'])
        it(`${value} is the identity, without warning`, () => {
            const { el, warnings } = fold(
                `<rect width="4" height="4" style="translate: ${value}; rotate: ${value}; scale: ${value}"/>`,
            );
            expect(warnings).toEqual([]);
            expect(el.attributes!.transform).toBeUndefined();
            expect(el.attributes!.style).toBeUndefined();
        });

    for (const optimize of MODES) {
        it(`rotate: 0 0 1 10deg folds like rotate: 10deg (optimize: ${optimize})`, () => {
            const xml = (rotate: string): string =>
                convert(doc(`style="rotate: ${rotate}"`, second), { optimize, strict: true }).xml;
            expect(xml('0 0 1 10deg')).toBe(xml('10deg'));
            expect(xml('10deg z')).toBe(xml('10deg'));
            expect(xml('0 0 -3 10deg')).toBe(xml('-10deg'));
            expect(xml('10deg')).not.toBe(xml('-10deg'));
        });

        it(`a null rotation on any axis is the identity, without warning (optimize: ${optimize})`, () => {
            for (const rotate of ['x 0deg', 'y 0turn', '1 1 0 0deg', '0deg 0 1 0', 'x 360deg']) {
                const { xml, warnings } = convert(doc(`style="rotate: ${rotate}"`, second), { optimize, strict: true });
                expect(codes(warnings), rotate).toEqual([]);
                expect(compareSvgs(doc('', second), vdToSvg(xml)).mismatch, rotate).toBeLessThan(DEFAULT_MAX_MISMATCH);
            }
        });

        it(`a comment holding "(" or "," in translate / rotate / scale is whitespace (optimize: ${optimize})`, () => {
            const source = doc(
                'style="translate: 5px /* (,) */ 10px; rotate: /* ) */ 90deg; scale: 2 /*,*/ 1"',
                second,
            );
            const { xml, warnings } = convert(source, { optimize, strict: true });
            expect(codes(warnings)).toEqual([]);
            const expected = doc('transform="translate(5 10) rotate(90) scale(2 1)"', second);
            expect(compareSvgs(expected, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        });
    }

    for (const [property, value] of [
        ['translate', '50%'],
        ['translate', '1px 2px 3px'],
        ['translate', 'calc(1px + 2px)'],
        ['rotate', 'x 10deg'],
        ['rotate', '1 1 0 10deg'],
        ['scale', '1 1 2'],
        ['rotate', '0 0 0 10deg'],
        ['scale', 'calc(2)'],
    ])
        for (const optimize of MODES) {
            const source = doc(`style="${property}: ${value}"`, second);
            it(`${property}: ${value} warns (optimize: ${optimize}) and strict rejects it`, () => {
                expect(codes(convert(source, { optimize }).warnings)).toEqual(['unsupported-style']);
                const error = conversionError(() => convert(source, { optimize, strict: true }));
                expect([error.warning.code, error.warning.node]).toEqual(['unsupported-style', 'g']);
            });
        }

    it('reports them on the root <svg>', () => {
        const { warnings } = fold('<rect width="4" height="4"/>', ' style="rotate: 10deg; scale: none"');
        expect(warnings).toEqual([
            {
                code: 'unsupported-style',
                message: 'rotate: 10deg on the root <svg> is not supported; ignored.',
                node: 'svg',
            },
        ]);
    });
});

describe('CSS transform with a unitless length or angle (invalid CSS: dropped, as by Chrome)', () => {
    // Chrome 2026-11: `transform: translate(5)` / `rotate(30)`, `translate: 5`, `rotate: 30` compute to
    // `none`; `translate(5px)`, `rotate(30deg)`, `scale: 2` apply. Only the attribute syntax is unitless.
    const doc = (attrs: string, extra = ''): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${extra}<rect class="r" x="5" y="5" width="10" height="4" fill="blue" ${attrs}/><rect x="5" y="20" width="10" height="4" fill="red"/></svg>`;
    const plain = doc('');
    const INVALID = [
        'transform: translate(5)',
        'transform: rotate(30)',
        'transform: translate(5px, 5)',
        'transform: skewX(10)',
        'translate: 5',
        'translate: 5px 5px 3',
        'rotate: 30',
        'rotate: z 30',
    ];

    it('the references differ from the untransformed rendering', () => {
        for (const t of ['translate(5)', 'rotate(30)', 'translate(5 5)', 'skewX(10)'])
            expect(compareSvgs(plain, doc(`transform="${t}"`)).mismatch, t).toBeGreaterThan(0.1);
    });

    for (const optimize of MODES) {
        for (const declaration of INVALID)
            it(`style="${declaration}" applies nothing, silently (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(doc(`style="${declaration}"`), { optimize, strict: true });
                expect(codes(warnings)).toEqual([]);
                expect(compareSvgs(plain, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

        for (const declaration of ['transform: translate(5)', 'rotate: 30'])
            it(`a <style> rule "${declaration}" applies nothing (optimize: ${optimize})`, () => {
                const { xml } = convert(doc('', `<style>.r { ${declaration} }</style>`), { optimize });
                expect(compareSvgs(plain, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

        for (const [label, source, expected] of [
            ['transform: translate(0)', doc('style="transform: translate(0)"'), plain],
            ['transform: translate(5px)', doc('style="transform: translate(5px)"'), doc('transform="translate(5)"')],
            ['transform: rotate(30deg)', doc('style="transform: rotate(30deg)"'), doc('transform="rotate(30)"')],
            ['scale: 2', doc('style="scale: 2"'), doc('transform="scale(2)"')],
            [
                'the attribute under an invalid CSS transform',
                doc('transform="rotate(30)" style="transform: translate(5)"'),
                doc('transform="rotate(30)"'),
            ],
            [
                'the valid declaration before an invalid one',
                doc('style="transform: translate(5px); transform: rotate(30)"'),
                doc('transform="translate(5)"'),
            ],
        ] as const)
            it(`${label} applies (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(source, { optimize, strict: true });
                expect(codes(warnings)).toEqual([]);
                expect(compareSvgs(expected, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

        it(`on the root <svg>, transform: rotate(30) is dropped too (optimize: ${optimize})`, () => {
            const source = plain.replace('<svg ', '<svg style="transform: rotate(30)" ');
            const { xml, warnings } = convert(source, { optimize, strict: true });
            expect(codes(warnings)).toEqual([]);
            expect(compareSvgs(plain, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        });
    }

    it('parseStyle drops the declaration, keeping a valid one before it', () => {
        expect(parseStyle('transform: rotate(30deg); transform: rotate(30)').transform).toBe('rotate(30deg)');
        expect(parseStyle('rotate: 1 1 0 10deg').rotate).toBe('1 1 0 10deg'); // a numeric axis is valid
        expect(parseStyle('translate: 0; rotate: 0; scale: 2').translate).toBe('0');
        expect(parseStyle('rotate: 30').rotate).toBeUndefined();
    });
});

describe('CSS transform with an invalid syntax (dropped silently, as by Chrome)', () => {
    // Chrome 2026-11 (CSS.supports): `banana`, `rotate(`, `translate(1px,,2px)`, `translate(1px 2px)`
    // (CSS takes commas), `scale(2px)`, `rotate(10px)`, `foo(1)` are dropped; `rotate(10deg` (closed
    // at the end of the value) and 3D functions are kept.
    const doc = (attrs: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect x="5" y="5" width="10" height="4" fill="blue" ${attrs}/><rect x="5" y="20" width="10" height="4" fill="red"/></svg>`;
    const attribute = doc('transform="rotate(30)"');

    it('the reference differs from the untransformed rendering', () => {
        expect(compareSvgs(doc(''), attribute).mismatch).toBeGreaterThan(0.1);
    });

    for (const optimize of MODES) {
        for (const value of ['banana', 'rotate(', 'translate(1px,,2px)', 'translate(5px 5px)', 'scale(2px)', 'foo(1)'])
            it(`transform: ${value} leaves the attribute, silently (optimize: ${optimize})`, () => {
                const source = doc(`transform="rotate(30)" style="transform: ${value}"`);
                const { xml, warnings } = convert(source, { optimize, strict: true });
                expect(codes(warnings)).toEqual([]);
                expect(compareSvgs(attribute, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

        it(`a valid declaration before an invalid one applies (optimize: ${optimize})`, () => {
            const source = doc('style="transform: rotate(30deg); transform: banana"');
            const { xml, warnings } = convert(source, { optimize, strict: true });
            expect(codes(warnings)).toEqual([]);
            expect(compareSvgs(attribute, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        });

        it(`an unclosed function is closed at the end of the value (optimize: ${optimize})`, () => {
            const { xml, warnings } = convert(doc('style="transform: rotate(30deg"'), { optimize, strict: true });
            expect(codes(warnings)).toEqual([]);
            expect(compareSvgs(attribute, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        });

        for (const value of ['matrix3d(1,0,0,0,0,1,0,0,0,0,2,0,0,0,0,1)', 'rotateX(10deg)', 'perspective(100px)'])
            it(`transform: ${value} (valid, not supported) still warns (optimize: ${optimize})`, () => {
                const source = doc(`style="transform: ${value}"`);
                expect(codes(convert(source, { optimize }).warnings)).toEqual(['unsupported-style']);
                const error = conversionError(() => convert(source, { optimize, strict: true }));
                expect(error.warning.code).toBe('unsupported-style');
            });
    }

    it('parseStyle keeps what Chrome keeps', () => {
        const kept = (v: string): boolean => parseStyle(`transform: ${v}`).transform !== undefined;
        for (const v of [
            'none',
            'Rotate(10DEG)',
            'rotate(0)',
            'translate( 1px , 2px )',
            'translate(1px)scale(2)',
            'translate(1px) /* c */ scale(2)',
            'scale(+.5) skew(0)',
            'translate(50%) translate(1ex) translate(calc(1px + 2px))',
            'translate3d(1px, 2px, 0) scaleZ(2) rotate3d(1, 0, 0, 10deg) perspective(none)',
            'matrix(1, 0, 0, 1, 0, 0)',
        ])
            expect(kept(v), v).toBe(true);
        for (const v of [
            'rotate()',
            'rotate(10deg))',
            'rotate(10deg) banana',
            'rotate(10deg), scale(2)',
            'none scale(2)',
            'translate(1px,)',
            'translate(1.px)',
            'translateX(1px 2px)',
            'translate(1px, 2px, 3px)',
            'skew(10deg, 20deg, 30deg)',
            'matrix(1 0 0 1 0 0)',
            'matrix(1, 0, 0, 1, 0, 5px)',
            'translate(10deg)',
            'rotate(10px)',
            'translateZ(5)',
            'translate3d(1px, 2px, 3)',
            'perspective(-1px)',
            'perspective(5)',
        ])
            expect(kept(v), v).toBe(false);
    });
});

describe('translate / rotate / scale with an invalid syntax (dropped silently, as by Chrome)', () => {
    // Chrome 156 (2026-11), `CSS.supports(property, value)`.
    const SUPPORTED: Record<'translate' | 'rotate' | 'scale', Record<string, boolean>> = {
        translate: {
            '0': true,
            '5px': true,
            '+5px': true,
            '.5px': true,
            '1e1px': true,
            '5PX': true,
            '5%': true,
            '5em': true,
            '5Q': true,
            '5px 5%': true,
            '0 0 0': true,
            '5px 5px 3px': true,
            'calc(1px + 2px) 5px': true,
            'calc(1px + 2px': true,
            'min(1px, 2px)': true,
            '1px /*c*/ 2px': true,
            '5px\t5px': true,
            '5': false,
            '0 5': false,
            '1.px': false,
            '5x': false,
            '5deg': false,
            banana: false,
            'none 5px': false,
            '5px,5px': false,
            '5px 5px 3': false,
            '5px 5px 5%': false,
            '5px 5px 0deg': false,
            '5px 5px 5px 5px': false,
        },
        rotate: {
            '30deg': true,
            '0deg': true,
            '-0deg': true,
            '0.5turn': true,
            '1rad': true,
            '100grad': true,
            '30DEG': true,
            'z 30deg': true,
            '30deg Z': true,
            'x 30deg': true,
            '30deg y': true,
            '1 1 0 30deg': true,
            '30deg 1 1 0': true,
            '.5 0 0 30deg': true,
            '0 0 0 30deg': true,
            'calc(10deg + 20deg)': true,
            'calc(30deg) z': true,
            'calc(1) 1 0 30deg': true,
            '30deg /**/ z': true,
            '0': false,
            '30': false,
            'z 0': false,
            'z 30': false,
            'x 0': false,
            '1 1 0 0': false,
            '30px': false,
            banana: false,
            z: false,
            '1 1 0': false,
            '1 1 30deg': false,
            '1 1 0 30': false,
            '1. 0 0 30deg': false,
            '1px 1 0 30deg': false,
            '1% 1 0 30deg': false,
            '30deg 30deg': false,
            'z z 30deg': false,
            'x y 30deg': false,
            '1 1 0 30deg z': false,
            '1, 1, 0, 30deg': false,
            '30deg,': false,
        },
        scale: {
            '2': true,
            '0': true,
            '-2': true,
            '+2': true,
            '.5': true,
            '1e1': true,
            '2%': true,
            '2 50%': true,
            '2 3 4': true,
            '2 3 100%': true,
            'calc(2 * 1) 3': true,
            '2 /**/ 3': true,
            '1.': false,
            '2px': false,
            '2deg': false,
            '2 2px': false,
            banana: false,
            '2,3': false,
            '2 none': false,
            '2 3 4 5': false,
        },
    };

    it('isValidPropertyValue agrees with Chrome', () => {
        for (const [property, values] of Object.entries(SUPPORTED))
            for (const [value, supported] of Object.entries(values))
                expect(isValidPropertyValue(property, value), `${property}: ${value}`).toBe(supported);
    });

    it('none and substitution functions are valid', () => {
        for (const property of ['translate', 'rotate', 'scale'])
            for (const value of ['none', 'NONE', 'var(--x)', 'inherit'])
                expect(isValidPropertyValue(property, value), `${property}: ${value}`).toBe(true);
    });

    it('parseStyle keeps a valid declaration before an invalid one (Chrome computes 30deg and 2)', () => {
        const css = parseStyle('rotate: 30deg; rotate: 0; scale: 2; scale: foo; translate: 1px; translate: 5');
        expect([css.rotate, css.scale, css.translate]).toEqual(['30deg', '2', '1px']);
    });

    const doc = (attrs: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect x="5" y="5" width="10" height="4" fill="blue" ${attrs}/><rect x="5" y="20" width="10" height="4" fill="red"/></svg>`;
    const plain = doc('');
    for (const optimize of MODES) {
        for (const declaration of [
            'translate: banana',
            'translate: 5px,5px',
            'translate: 5px 5px 5%',
            'rotate: 0',
            'rotate: 30px',
            'rotate: 1 1 30deg',
            'scale: 2px',
            'scale: foo',
            'scale: 2 3 4 5',
        ])
            it(`style="${declaration}" applies nothing, silently (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(doc(`style="${declaration}"`), { optimize, strict: true });
                expect(codes(warnings)).toEqual([]);
                expect(compareSvgs(plain, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

        it(`a valid declaration before an invalid one applies (optimize: ${optimize})`, () => {
            const source = doc('style="rotate: 30deg; rotate: 30px; scale: 2; scale: 2px"');
            const { xml, warnings } = convert(source, { optimize, strict: true });
            expect(codes(warnings)).toEqual([]);
            const expected = doc('transform="rotate(30) scale(2)"');
            expect(compareSvgs(plain, expected).mismatch).toBeGreaterThan(0.1);
            expect(compareSvgs(expected, vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
        });

        it(`translate with a comment between its components applies (optimize: ${optimize})`, () => {
            const { xml, warnings } = convert(doc('style="translate: 5px /* x */ 10px"'), { optimize, strict: true });
            expect(codes(warnings)).toEqual([]);
            expect(compareSvgs(doc('transform="translate(5 10)"'), vdToSvg(xml)).mismatch).toBeLessThan(
                DEFAULT_MAX_MISMATCH,
            );
        });
    }
});

describe('offset-path and CSS mask images', () => {
    for (const [property, value] of [
        ['offset-path', "path('M0 0 H20')"],
        ['mask-image', 'linear-gradient(black, transparent)'],
        ['-webkit-mask-image', 'linear-gradient(black, transparent)'],
        ['mask-border', 'url(#b) 30'],
        // Chrome paints nothing for these three.
        ['-webkit-mask', 'linear-gradient(transparent, transparent)'],
        ['-webkit-mask-box-image', 'linear-gradient(transparent, transparent)'],
        ['-webkit-mask-box-image-source', 'linear-gradient(transparent, transparent)'],
    ])
        for (const optimize of MODES) {
            const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="10" height="10" style="${property}: ${value}"/></svg>`;
            it(`${property} warns (optimize: ${optimize}) and strict rejects it`, () => {
                expect(convert(source, { optimize }).warnings).toEqual([
                    {
                        code: 'unsupported-style',
                        message: expect.stringMatching(
                            new RegExp(`^${property}: .* cannot be represented in a VectorDrawable; ignored\\.$`),
                        ),
                        node: optimize ? 'path' : 'rect',
                    },
                ]);
                const error = conversionError(() => convert(source, { optimize, strict: true }));
                expect(error.warning.code).toBe('unsupported-style');
            });
        }

    for (const value of ['none', 'initial', 'unset'])
        it(`${value} does not warn`, () => {
            const style = [
                'offset-path',
                'mask-image',
                '-webkit-mask-image',
                'mask-border',
                '-webkit-mask',
                '-webkit-mask-box-image',
                '-webkit-mask-box-image-source',
            ]
                .map((p) => `${p}: ${value}`)
                .join('; ');
            expect(fold(`<rect width="4" height="4" style="${style}"/>`).warnings).toEqual([]);
        });
});

describe('CSS d: path() string (movetos alone, CSS escapes)', () => {
    const square = 'M0 0h10v10H0z';
    const doc = (body: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}<path d="M20 20h4v4h-4z"/></svg>`;
    const withCss = (value: string): string =>
        doc(`<path d="${square}" fill="red" style="d: ${value.replace(/"/g, '&quot;')}"/>`);
    const pathData = (xml: string): string[] => [...xml.matchAll(/android:pathData="([^"]*)"/g)].map((m) => m[1]!);

    for (const optimize of MODES) {
        describe(`optimize: ${optimize}`, () => {
            it.each([`path('M 5 5')`, `path('M5 5 M6 6')`])(
                'draws nothing for %s, with the warning of d="M5 5" (Chrome: valid, no geometry)',
                (value) => {
                    const css = convert(withCss(value), { optimize });
                    const attribute = convert(doc('<path d="M5 5" fill="red"/>'), { optimize });
                    expect(pathData(css.xml)).toEqual(['M20 20h4v4h-4z']);
                    expect(css.warnings).toEqual(attribute.warnings);
                    expect(codes(css.warnings)).toEqual(['empty-path']);
                },
            );

            // Closed shapes: a flat path with only a fill is not written (T-184).
            it.each([
                String.raw`path('M0 0\68 5v5z')`,
                String.raw`path("M0 0\000068 5v5z")`,
                String.raw`path('M0\ 0h5v5z')`,
            ])('decodes the CSS escapes of %s (Chrome: M 0 0 H 5 V 5 Z)', (value) => {
                const { xml, warnings } = convert(withCss(value), { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(pathData(xml)[0]).toBe('M0 0h5v5z');
            });

            it.each([
                `path('M0 0 H20 Z X 5')`,
                String.raw`path('M0 0\0 h5')`, // U+FFFD
                String.raw`path('M0 0\110000 h5')`, // out of range: U+FFFD
                String.raw`path('M0 0\68')`, // `\68` alone: `M0 0h`
                String.raw`path('M0 0 h5\')`, // the quote is escaped: unterminated string
            ])('ignores %s, in error once decoded: the attribute is drawn (Chrome)', (value) => {
                const { xml, warnings } = convert(withCss(value), { optimize, strict: true });
                expect(warnings).toEqual([]);
                expect(pathData(xml)[0]).toBe(square);
            });

            it(String.raw`reads path('M0 0h5v5\zz') as M0 0h5v5zz, a valid string (Chrome: M 0 0 H 5 V 5 Z Z)`, () => {
                const { xml, warnings } = convert(withCss(String.raw`path('M0 0h5v5\zz')`), { optimize });
                expect(warnings).toEqual([]);
                expect(pathData(xml)[0]).toBe('M0 0h5v5zz');
            });
        });
    }

    it('decodes CSS Syntax 3 escapes in the path() string', () => {
        expect(cssPathString("path('M0 0\\\nh5')")).toBe('M0 0h5'); // escaped newline: removed
        expect(cssPathString(String.raw`path('\4D\9 0 0')`)).toBe('M\t0 0'); // one whitespace ends the hex
        expect(cssPathString(String.raw`path('\d800\0 \110000')`)).toBe('\uFFFD\uFFFD\uFFFD');
        expect(cssPathString(String.raw`path("\"\\")`)).toBe('"\\');
        expect(cssPathString("path('M0 0\nh5')")).toBeUndefined(); // raw newline: bad string
        expect(cssPathString(`url(#a)`)).toBeUndefined();
    });

    it('gives the same XML in both modes', () => {
        for (const value of [String.raw`path('M0 0\68 5')`, `path('M 5 5')`, String.raw`path('M0 0\0 h5')`])
            expect(convert(withCss(value), { optimize: true }).xml).toBe(
                convert(withCss(value), { optimize: false }).xml,
            );
    });
});

describe('CSS properties on definitions: reported only once rendered', () => {
    const doc = (body: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}<path d="M20 20h4v4h-4z"/></svg>`;
    const blend = '<path id="p" d="M0 0h5v5z" style="mix-blend-mode: multiply"/>';
    const unresolved = '<path id="p" d="M0 0h5v5z" style="d: var(--x)"/>';
    const BLEND = 'mix-blend-mode: multiply on <path> cannot be represented in a VectorDrawable; ignored.';
    const UNRESOLVED = 'd: var(--x) on <path> cannot be resolved; the path is not drawn.';
    const messages = (warnings: Warning[]): string[] =>
        warnings.filter((w) => w.code !== 'large-vector').map((w) => w.message);

    for (const optimize of MODES)
        describe(`optimize: ${optimize}`, () => {
            it.each([
                ['an unreferenced <defs> path with d: var()', `<defs>${unresolved}</defs>`],
                ['an unreferenced <defs> path with mix-blend-mode', `<defs>${blend}</defs>`],
                ['an unreferenced <symbol>', `<symbol id="s">${blend}</symbol>`],
                ['the content of an unreferenced <clipPath>', `<clipPath id="c">${blend}</clipPath>`],
                [
                    'offset-path / mask-image / path-length in <defs>',
                    `<defs><rect id="r" width="2" height="2" style="offset-path: path('M0 0 H20'); mask-image: linear-gradient(black, white); path-length: 10"/></defs>`,
                ],
                ['a <use> that is itself unreferenced', `<defs>${blend}<g id="g"><use href="#p"/></g></defs>`],
                ['a link to the definition', `<defs>${blend}</defs><a href="#p"><rect width="2" height="2"/></a>`],
                [
                    '-webkit-mask* in an unreferenced <defs>',
                    `<defs><rect id="r" width="2" height="2" style="-webkit-mask: linear-gradient(red, red); -webkit-mask-box-image-source: linear-gradient(red, red)"/></defs>`,
                ],
            ])('does not warn for %s, and strict passes', (_, body) => {
                expect(messages(convert(doc(body), { optimize }).warnings)).toEqual([]);
                expect(() => convert(doc(body), { optimize, strict: true })).not.toThrow();
            });

            it.each([1, 2])('warns exactly once for a definition used by %i <use>', (uses) => {
                const body = `<defs>${blend}</defs>` + '<use href="#p"/>'.repeat(uses);
                expect(messages(convert(doc(body), { optimize }).warnings)).toEqual([BLEND]);
                expect(() => convert(doc(body), { optimize, strict: true })).toThrow(ConversionError);
            });

            it.each([
                ['a <use> of a nested element', `<defs><g id="g">${unresolved}</g></defs><use href="#g"/>`, UNRESOLVED],
                [
                    'a <use> chain through <defs>',
                    `<defs>${unresolved}<use id="u" href="#p"/></defs><use href="#u"/>`,
                    UNRESOLVED,
                ],
                ['an instantiated <symbol>', `<symbol id="s">${blend}</symbol><use href="#s"/>`, BLEND],
                [
                    'a referenced <clipPath>',
                    `<clipPath id="c">${blend}</clipPath><rect width="9" height="9" clip-path="url(#c)"/>`,
                    BLEND,
                ],
                [
                    'a <clipPath> referenced from a style',
                    `<clipPath id="c">${blend}</clipPath><rect width="9" height="9" style="clip-path: url('#c')"/>`,
                    BLEND,
                ],
            ])('warns for %s', (_, body, message) => {
                expect(messages(convert(doc(body), { optimize }).warnings)).toEqual([message]);
            });

            it('still applies a CSS transform in <defs> to the clone', () => {
                const folded = convert(
                    doc(
                        '<defs><path id="p" d="M0 0h5v5z" style="transform: translate(3px, 4px)"/></defs><use href="#p"/>',
                    ),
                    { optimize, strict: true },
                );
                const attribute = convert(
                    doc('<defs><path id="p" d="M0 0h5v5z" transform="translate(3 4)"/></defs><use href="#p"/>'),
                    { optimize, strict: true },
                );
                expect(folded.xml).toBe(attribute.xml);
                expect(folded.xml).toMatch(/translate(?:X="3"[^>]*translateY="4"|Y="4"[^>]*translateX="3")/);
            });
        });

    it('folds transforms of unreferenced definitions too, silently', () => {
        const root = parseSvg(
            '<svg xmlns="http://www.w3.org/2000/svg"><defs><rect id="r" style="transform: scale(2); mix-blend-mode: screen"/></defs></svg>',
            false,
        );
        const warnings: Warning[] = [];
        applyCssProperties(root, (w) => warnings.push(w));
        const defs = (root.children[0] as XastElement).children![0] as XastElement;
        const r = (defs.children![0] as XastElement).attributes!;
        expectMatrix(parseTransform(r.transform), { ...IDENTITY, a: 2, d: 2 });
        expect(r.style).toBe('mix-blend-mode:screen');
        expect(warnings).toEqual([]);
    });
});

describe('CSS properties on content never rendered: not reported', () => {
    const doc = (body: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}<path d="M20 20h4v4h-4z"/></svg>`;
    const blend = '<rect width="5" height="5" style="mix-blend-mode: multiply"/>';
    const BLEND_RECT = /^mix-blend-mode: multiply on <(rect|path)> cannot be represented/;
    const messages = (warnings: Warning[]): string[] =>
        warnings.filter((w) => w.code !== 'large-vector').map((w) => w.message);

    for (const optimize of MODES)
        describe(`optimize: ${optimize}`, () => {
            it.each([
                ['mix-blend-mode under display: none', `<g display="none">${blend}</g>`],
                ['d: var() under display: none', '<g display="none"><path d="M0 0h5v5z" style="d: var(--x)"/></g>'],
                [
                    'a <use> under display: none (its definition is not instantiated)',
                    `<defs><rect id="r" width="5" height="5" style="mix-blend-mode: multiply"/></defs><g display="none"><use href="#r"/></g>`,
                ],
                ['the <switch> child not picked', `<switch><rect width="5" height="5"/>${blend}</switch>`],
                ['a failing requiredExtensions', `<g requiredExtensions="http://example.com/x">${blend}</g>`],
                ['a <path> whose CSS d is none', '<path d="M0 0h5v5z" style="d: none; mix-blend-mode: multiply"/>'],
                [
                    'a gradient referenced only from display: none content',
                    '<linearGradient id="l" style="transform: scale(2); transform-origin: 50% 50%"><stop offset="0"/></linearGradient><rect width="5" height="5" display="none" fill="url(#l)"/>',
                ],
                [
                    '-webkit-mask under a failing systemLanguage',
                    '<g systemLanguage=""><rect width="5" height="5" style="-webkit-mask: linear-gradient(red, red)"/></g>',
                ],
            ])('does not warn for %s, and strict passes', (_, body) => {
                expect(messages(convert(doc(body), { optimize }).warnings)).toEqual([]);
                expect(() => convert(doc(body), { optimize, strict: true })).not.toThrow();
            });

            it.each([
                ['a visible <rect>', blend],
                ['the <switch> child picked', `<switch>${blend}<rect width="5" height="5"/></switch>`],
            ])('still warns for %s', (_, body) => {
                const found = messages(convert(doc(body), { optimize }).warnings);
                expect(found).toHaveLength(1);
                expect(found[0]).toMatch(BLEND_RECT);
                expect(() => convert(doc(body), { optimize, strict: true })).toThrow(ConversionError);
            });

            it('still reports a visible <path> whose CSS d cannot be resolved, and only that', () => {
                const body = '<path d="M0 0h5v5z" style="d: var(--x); mix-blend-mode: multiply"/>';
                expect(messages(convert(doc(body), { optimize }).warnings)).toEqual([
                    'd: var(--x) on <path> cannot be resolved; the path is not drawn.',
                ]);
            });
        });
});

describe('styleDeclarations: only top-level semicolons end a declaration', () => {
    it("keeps a ; inside url('…') with the value", () => {
        expect(parseStyle("fill:url('data:image/png;base64,AAAA') red;stroke:blue")).toEqual({
            fill: "url('data:image/png;base64,AAAA') red",
            stroke: 'blue',
        });
        expect(parseStyle('fill:url(data:image/png;base64,AAAA) red;stroke:blue').stroke).toBe('blue');
    });

    it('keeps a ; inside a string, escapes included', () => {
        expect(parseStyle("font-family:'a;b';fill:red")).toEqual({ 'font-family': "'a;b'", fill: 'red' });
        expect(parseStyle('font-family:"a\\";b";fill:red')).toEqual({ 'font-family': '"a\\";b"', fill: 'red' });
        expect(parseStyle('font-family:a\\;b;fill:red')).toEqual({ 'font-family': 'a\\;b', fill: 'red' });
    });

    it('lets an unclosed parenthesis swallow the rest of the declarations', () => {
        expect(styleDeclarations('stroke:blue;fill:url(#a;stroke:red')).toEqual([
            ['stroke', 'blue', false],
            ['fill', 'url(#a;stroke:red', false],
        ]);
    });

    it('still splits on plain semicolons, ignoring empty declarations', () => {
        expect(styleDeclarations(';fill:red;;stroke:blue !important;')).toEqual([
            ['fill', 'red', false],
            ['stroke', 'blue', true],
        ]);
    });

    for (const optimize of MODES)
        it(`reads a url('…;…') paint whole, and the declaration after it (optimize: ${optimize})`, () => {
            const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" style="fill:url('data:image/png;base64,AAAA') red;stroke:blue"/></svg>`;
            const { xml, warnings } = convert(source, { optimize });
            expect(xml).toMatch(/strokeColor="#FF0000FF"/);
            // The message quotes the whole value, not `url('data:image/png`.
            expect(warnings.map((w) => w.message)).toEqual([expect.stringContaining('base64,AAAA')]);
        });
});

/** The inline `style` svgo's minifyStyles (csso) writes for `style`. */
const minifiedStyle = (style: string): string | undefined =>
    svgoOptimize(`<svg xmlns="http://www.w3.org/2000/svg"><rect style="${style}"/></svg>`, {
        plugins: ['minifyStyles'],
    }).data.match(/style="([^"]*)"/)?.[1];

describe('cssComponents / cssListItems: split as the CSS tokenizer (T-156)', () => {
    it('ends a component after a `%` or a top-level `)`', () => {
        expect(cssComponents('50%2')).toEqual(['50%', '2']);
        expect(cssComponents('50%.5')).toEqual(['50%', '.5']);
        expect(cssComponents('1e1%2 1')).toEqual(['1e1%', '2', '1']);
        expect(cssComponents('10%top')).toEqual(['10%', 'top']);
        expect(cssComponents('50%-2')).toEqual(['50%', '-2']);
        expect(cssComponents('calc(90deg)0 0 1')).toEqual(['calc(90deg)', '0', '0', '1']);
        expect(cssComponents('url(#a)#fff')).toEqual(['url(#a)', '#fff']);
        expect(cssComponents('var(--x)0')).toEqual(['var(--x)', '0']);
    });

    it('keeps what is inside a function, a dimension and a sign after a unit', () => {
        expect(cssComponents('calc(50% + 2px) 3')).toEqual(['calc(50% + 2px)', '3']);
        expect(cssComponents('5px5')).toEqual(['5px5']);
        expect(cssComponents('0 0-1 45deg')).toEqual(['0', '0', '-1', '45deg']);
        expect(cssComponents('5px-1px')).toEqual(['5px-1px']);
    });

    it('reads a top-level comma as a component of its own', () => {
        expect(cssComponents('5px,5px')).toEqual(['5px', ',', '5px']);
        expect(cssComponents('10%,5')).toEqual(['10%', ',', '5']);
        expect(cssComponents('rgb(0,0,0)')).toEqual(['rgb(0,0,0)']);
    });

    it('lists items separated by whitespace and / or one comma', () => {
        expect(cssListItems('10%5')).toEqual(['10%', '5']);
        expect(cssListItems('1, 2 3')).toEqual(['1', '2', '3']);
        expect(cssListItems('10%,5')).toEqual(['10%', '5']);
        for (const v of ['1,,2', '1,', ',1', '1, ,2', '']) expect(cssListItems(v), v).toBeNull();
    });
});

describe('csso drops the space after `%` or `)` (T-156)', () => {
    // The forms csso 5.0.5 writes, which the converter must read as the authored ones.
    it('csso probe: the minified forms', () => {
        expect(minifiedStyle('scale: 50% 2')).toBe('scale:50%2');
        expect(minifiedStyle('scale: 50% 0.5')).toBe('scale:50%.5');
        expect(minifiedStyle('translate: 10% 0')).toBe('translate:10%0');
        expect(minifiedStyle('transform-origin: 50% 0')).toBe('transform-origin:50%0');
        expect(minifiedStyle('transform-origin: 10% top')).toBe('transform-origin:10%top');
        expect(minifiedStyle('rotate: calc(90deg) 0 0 1')).toBe('rotate:calc(90deg)0 0 1');
        expect(minifiedStyle('stroke-dasharray: 10% 5')).toBe('stroke-dasharray:10%5');
        expect(minifiedStyle('fill: url(#a) #fff')).toBe('fill:url(#a)#fff');
        // Kept: after a unit or a bare number, and around commas inside a function.
        expect(minifiedStyle('translate: 10px 0')).toBe('translate:10px 0');
        expect(minifiedStyle('scale: 2 50%')).toBe('scale:2 50%');
        expect(minifiedStyle('transform: translate(10%, 5px)')).toBe('transform:translate(10%,5px)');
    });

    const doc = (attrs: string): string =>
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><g ${attrs}><path fill="blue" d="M5 0h10v4H5z"/>` +
        '<path fill="red" d="M5 10h10v4H5z"/></g></svg>';
    // resvg reads neither the individual transforms nor `transform-origin`: the references spell them out.
    for (const [style, expected] of [
        ['scale: 50% 2', 'transform="scale(0.5 2)"'],
        ['scale: 50% 0.5 1', 'transform="scale(0.5 0.5)"'],
        ['rotate: 90deg; transform-origin: 50% 0', 'transform="rotate(90 20 0)"'],
        ['rotate: 90deg; transform-origin: 10% top', 'transform="rotate(90 4 0)"'],
        ['scale: 2; transform-origin: 50% 0 0', 'transform="translate(20 0) scale(2) translate(-20 0)"'],
    ] as const)
        for (const optimize of MODES)
            it(`applies ${style} under strict (optimize: ${optimize})`, () => {
                const { xml, warnings } = convert(doc(`style="${style}"`), { optimize, strict: true });
                expect(codes(warnings)).toEqual([]);
                expect(compareSvgs(doc(expected), vdToSvg(xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            });

    it('the references differ from the untransformed rendering', () => {
        expect(compareSvgs(doc(''), doc('transform="scale(0.5 2)"')).mismatch).toBeGreaterThan(0.05);
        expect(compareSvgs(doc(''), doc('transform="rotate(90 20 0)"')).mismatch).toBeGreaterThan(0.05);
    });

    // Not foldable: reported in both modes (csso's form used to be dropped as invalid, silently).
    for (const style of ['translate: 10% 0', 'rotate: calc(90deg) 0 0 1', 'scale: calc(2) 3'])
        it(`reports ${style} in both modes, with the same output`, () => {
            const run = (optimize: boolean) => convert(doc(`style="${style}"`), { optimize });
            const [plain, optimized] = [run(false), run(true)];
            expect(codes(plain.warnings)).toEqual(['unsupported-style']);
            expect(codes(optimized.warnings)).toEqual(codes(plain.warnings));
            expect(compareSvgs(vdToSvg(plain.xml), vdToSvg(optimized.xml)).mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
            for (const optimize of MODES)
                expect(
                    conversionError(() => convert(doc(`style="${style}"`), { optimize, strict: true })).warning.code,
                ).toBe('unsupported-style');
        });

    for (const optimize of MODES)
        it(`a paint with a url() fallback keeps its fallback (optimize: ${optimize})`, () => {
            const source =
                '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" style="fill: url(#missing) #00f"/></svg>';
            expect(convert(source, { optimize }).xml).toMatch(/fillColor="#FF0000FF"/);
        });
});
