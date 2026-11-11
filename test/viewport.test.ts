import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, ConversionError } from '../src/index.js';
import { applyPoint, parseTransformOrigin, type Matrix } from '../src/transform.js';
import type { XastElement } from '../src/ast.js';
import { parseSvg } from '../src/normalize.js';
import { layoutWarnings, nestedLayout, rootLayout, rootTransform } from '../src/viewport.js';
import { vdToSvg } from './visual/vdToSvg.js';
import { compareSvgs, DEFAULT_MAX_MISMATCH } from './visual/compare.js';

const repro = (file: string): string =>
    readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'wpt-repro', file), 'utf8');

const svg = (attrs: string, body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

/** The ConversionError thrown by `run`, or a failure when it does not throw one. */
function conversionError(run: () => unknown): ConversionError {
    try {
        run();
    } catch (e) {
        if (e instanceof ConversionError) return e;
        throw e;
    }
    throw new Error('expected a ConversionError');
}

/** Asserts the converted drawable renders like `reference` (resvg, both optimize modes). */
function expectRendersLike(source: string, reference = source): void {
    for (const optimize of [true, false]) {
        const result = compareSvgs(reference, vdToSvg(convert(source, { optimize, strict: true }).xml));
        expect(result.sizeMismatch).toBeNull();
        expect(result.inked).toBeGreaterThan(0);
        expect(result.mismatch).toBeLessThan(DEFAULT_MAX_MISMATCH);
    }
}

describe('root without a size', () => {
    it('wpt-sizeless-root.svg: rejected by strict as unsupported-attribute', () => {
        for (const optimize of [true, false]) {
            const error = conversionError(() => convert(repro('wpt-sizeless-root.svg'), { optimize, strict: 'lossy' }));
            expect(error.warning.code).toBe('unsupported-attribute');
            expect(error.warning.node).toBe('svg');
        }
    });

    it('still assumes 24×24 outside strict, with a warning', () => {
        const { xml, warnings } = convert(repro('wpt-sizeless-root.svg'));
        expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
        expect(warnings[0]!.message).toContain('width / height');
        expect(xml).toContain('android:width="24dp"');
        expect(xml).toContain('android:viewportHeight="24"');
    });

    it('reports only the missing dimension', () => {
        const { xml, warnings } = convert(svg('width="48"', '<rect width="10" height="10"/>'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.message).toContain('usable height');
        expect(xml).toContain('android:width="48dp"');
        expect(xml).toContain('android:height="24dp"');
    });

    it('a percentage or zero size does not define one', () => {
        expect(rootLayout({ width: '100%', height: '0' }).assumed).toEqual(['width', 'height']);
    });

    it('a viewBox, or both width and height, define the size: no warning', () => {
        for (const attrs of ['viewBox="0 0 24 24"', 'width="32" height="16"', 'viewBox="0 0 10 10" width="5"'])
            expect(convert(svg(attrs, '<rect width="4" height="4"/>'), { strict: true }).warnings).toEqual([]);
    });
});

// SVG 2 §8.6: a zero viewBox width or height disables rendering, a negative one is an error. Browsers
// render nothing (wpt coordinate-systems/viewBox-zero-disables-rendering-00{1,2,3}).
describe('root viewBox with a zero or negative width / height', () => {
    const rect = '<rect width="100" height="100" fill="green"/>';

    it.each(['0 0 0 100', '0 0 100 0', '0 0 0 0', '0 0 -24 24', '0 0 24 -1'])(
        'viewBox="%s": an empty <vector> sized without the viewBox, lossy',
        (viewBox) => {
            for (const optimize of [true, false]) {
                const { xml, warnings } = convert(svg(`width="200" height="100" viewBox="${viewBox}"`, rect), {
                    optimize,
                });
                expect(xml).not.toContain('<path');
                expect(xml).toContain('android:width="200dp"');
                expect(xml).toContain('android:viewportHeight="100"');
                expect(warnings).toEqual([
                    {
                        code: 'unsupported-attribute',
                        message: `The root <svg> has viewBox="${viewBox}", whose width or height is not positive: nothing is rendered; the <vector> is empty.`,
                        node: 'svg',
                    },
                ]);
                const error = conversionError(() =>
                    convert(svg(`viewBox="${viewBox}"`, rect), { optimize, strict: 'lossy' }),
                );
                expect(error.warning.code).toBe('unsupported-attribute');
            }
        },
    );

    it('without a size: 24×24, no "assumed 24" warning (nothing is drawn)', () => {
        for (const optimize of [true, false]) {
            const { xml, warnings } = convert(svg('viewBox="0 0 0 24"', rect), { optimize });
            expect(xml).toContain('android:width="24dp"');
            expect(warnings.map((w) => w.message)).toEqual([expect.stringContaining('viewBox="0 0 0 24"')]);
        }
    });

    it('a hidden root reports nothing: display none already renders nothing', () => {
        for (const optimize of [true, false])
            expect(
                convert(svg('display="none" viewBox="0 0 0 24"', rect), { optimize, strict: true }).warnings,
            ).toEqual([]);
    });
});

describe('root that draws nothing, without a size', () => {
    it.each(['', 'display="none"', 'style="display:none"'])('<svg %s>: 24×24, no warning, even strict', (attrs) => {
        const body = attrs ? '<rect width="100" height="100"/>' : '';
        for (const optimize of [true, false]) {
            const { xml, warnings } = convert(svg(attrs, body), { optimize, strict: true });
            expect(warnings).toEqual([]);
            expect(xml).toContain('android:width="24dp"');
            expect(xml).not.toContain('<path');
        }
    });

    it.each([
        ['only definitions', '<defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><title>t</title>'],
        [
            'only hidden children',
            '<rect width="10" height="10" display="none"/><g style="display:none"><circle r="5"/></g>',
        ],
        ['only failed conditions', '<rect width="10" height="10" requiredExtensions="http://example.org/x"/>'],
        // Containers draw through their descendants (svgo drops the empty groups in optimize: true).
        ['a group of definitions', '<g><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs></g>'],
        ['an empty group', '<g/>'],
        ['a group of hidden children', '<g><rect width="5" height="5" display="none"/></g>'],
        ['nested empty groups and links', '<g><a href="#x"><g/></a></g>'],
        [
            'a switch picking a hidden child',
            '<switch><rect width="5" height="5" display="none"/><circle r="5"/></switch>',
        ],
    ])('%s: no warning, even strict', (_, body) => {
        for (const optimize of [true, false])
            expect(convert(svg('', body), { optimize, strict: true }).warnings).toEqual([]);
    });

    it.each([
        ['a shape', '<rect width="10" height="10"/>'],
        ['a shape in a group', '<g><rect width="5" height="5"/></g>'],
        ['a shape in a link in a group', '<g><a href="#x"><rect width="5" height="5"/></a></g>'],
        [
            'the shape a switch picks',
            '<switch><g requiredExtensions="http://example.org/x"/><rect width="5" height="5"/></switch>',
        ],
    ])('content drawn (%s): the "assumed 24" warning stays', (_, body) => {
        for (const optimize of [true, false])
            expect(convert(svg('', body), { optimize }).warnings).toEqual([
                expect.objectContaining({
                    code: 'unsupported-attribute',
                    message: expect.stringContaining('assumed 24'),
                }),
            ]);
    });
});

// SVG 2 §8.12 (intrinsic sizing): a percentage or missing width / height gives no intrinsic size, the
// viewBox gives the intrinsic aspect ratio; CSS replaced-element sizing derives the other dimension.
// Checked in Firefox 158 and Chrome 157 (`<img>` of the SVG). resvg 2.6 keeps the viewBox's dimension
// instead, so the references below spell out both sizes.
describe('root with a viewBox and a single dimension', () => {
    const shapes = '<rect width="10" height="20" fill="green"/><circle cx="5" cy="5" r="4" fill="red"/>';
    const size = (attrs: Record<string, string>) => {
        const { width, height, viewportWidth, viewportHeight, offsetX, offsetY } = rootLayout(attrs);
        return { width, height, viewportWidth, viewportHeight, offsetX, offsetY };
    };
    const unscaled = { viewportWidth: 10, viewportHeight: 20, offsetX: 0, offsetY: 0 };

    it('width only: the height follows the viewBox ratio', () => {
        expect(size({ viewBox: '0 0 10 20', width: '5' })).toEqual({ width: 5, height: 10, ...unscaled });
        expectRendersLike(
            svg('viewBox="0 0 10 20" width="5"', shapes),
            svg('viewBox="0 0 10 20" width="5" height="10"', shapes),
        );
    });

    it('height only: the width follows the viewBox ratio', () => {
        expect(size({ viewBox: '0 0 10 20', height: '5' })).toEqual({ width: 2.5, height: 5, ...unscaled });
        expectRendersLike(
            svg('viewBox="0 0 10 20" height="40"', shapes),
            svg('viewBox="0 0 10 20" width="20" height="40"', shapes),
        );
    });

    it('a percentage is no size: the other dimension sets it through the ratio', () => {
        expect(size({ viewBox: '0 0 10 20', width: '50%', height: '5' })).toEqual({
            width: 2.5,
            height: 5,
            ...unscaled,
        });
        expect(size({ viewBox: '0 0 10 20', width: '5', height: '50%' })).toEqual({
            width: 5,
            height: 10,
            ...unscaled,
        });
    });

    it('preserveAspectRatio="none" keeps the viewBox ratio (SVG 2 §8.12; Firefox)', () => {
        for (const preserveAspectRatio of ['none', 'xMinYMin slice'])
            expect(size({ viewBox: '0 0 10 20', width: '5', preserveAspectRatio })).toEqual({
                width: 5,
                height: 10,
                ...unscaled,
            });
    });

    it('keeps the viewBox origin offset', () => {
        expect(size({ viewBox: '-2 3 10 20', height: '40' })).toEqual({
            width: 20,
            height: 40,
            viewportWidth: 10,
            viewportHeight: 20,
            offsetX: 2,
            offsetY: -3,
        });
    });

    it('no usable dimension: the viewBox size, as before', () => {
        const cases: Record<string, string>[] = [{}, { width: '50%' }, { width: '0', height: '1ex' }];
        for (const attrs of cases)
            expect(size({ viewBox: '0 0 10 20', ...attrs })).toEqual({ width: 10, height: 20, ...unscaled });
    });

    it('the width / height options scale from the derived size', () => {
        const source = svg('viewBox="0 0 10 20" width="5"', shapes);
        expect(convert(source, { width: 30 }).xml).toContain('android:height="60dp"');
        expect(convert(source, { height: 30 }).xml).toContain('android:width="15dp"');
    });

    it('large-vector sees the derived dimension', () => {
        const { xml, warnings } = convert(svg('viewBox="0 0 10 20" height="4000"', shapes));
        expect(xml).toContain('android:width="2000dp"');
        expect(warnings.map((w) => w.code)).toContain('large-vector');
    });
});

// Chrome 157 (`<img>` of the SVG): the CSS `width` / `height` of the root <svg> override its
// attributes (presentation attributes); `auto`, a percentage or an invalid declaration leave the
// attribute (or the viewBox) in charge.
describe('CSS size of the root <svg>', () => {
    const rect = '<rect width="24" height="24" fill="green"/>';
    const size = (attrs: Record<string, string>) => {
        const { width, height } = rootLayout(attrs);
        return [width, height];
    };
    const dp = (source: string, optimize: boolean): string[] =>
        convert(source, { optimize, strict: true }).xml.match(/android:(?:width|height)="[^"]*"/g) ?? [];

    it('style="width:48px;height:48px" → 48dp, with or without the attributes, both modes', () => {
        for (const attrs of [
            'viewBox="0 0 24 24"',
            'viewBox="0 0 24 24" width="24" height="24"',
            'width="24" height="24"',
        ])
            for (const optimize of [true, false]) {
                const source = svg(`${attrs} style="width:48px;height:48px"`, rect);
                expect(convert(source, { optimize, strict: true }).warnings).toEqual([]);
                expect(dp(source, optimize)).toEqual(['android:width="48dp"', 'android:height="48dp"']);
            }
    });

    it('renders like the same size in attributes', () => {
        expectRendersLike(
            svg('viewBox="0 0 24 24" width="24" style="width:48px;height:48px"', rect),
            svg('viewBox="0 0 24 24" width="48" height="48"', rect),
        );
    });

    it('style="width:48px" with a square viewBox → 48×48 (the ratio sets the height)', () => {
        expect(size({ viewBox: '0 0 24 24', style: 'width:48px' })).toEqual([48, 48]);
        expect(size({ viewBox: '0 0 24 24', height: '24', style: 'width:48px' })).toEqual([48, 24]);
        for (const optimize of [true, false])
            expect(dp(svg('viewBox="0 0 24 24" style="width:48px"', rect), optimize)).toEqual([
                'android:width="48dp"',
                'android:height="48dp"',
            ]);
    });

    it('absolute and font-relative units are resolved like the attribute', () => {
        expect(size({ viewBox: '0 0 24 24', style: 'width:0.5in;height:3em' })).toEqual([48, 48]);
        expect(size({ viewBox: '0 0 24 24', style: 'WIDTH: 36PT' })).toEqual([48, 48]);
    });

    it('auto, a percentage, zero or another sizing keyword leave the attribute in charge', () => {
        for (const width of ['auto', '50%', '0', '0px', 'initial', 'inherit', 'max-content'])
            expect(size({ viewBox: '0 0 24 24', width: '32', style: `width:${width}` })).toEqual([32, 32]);
        expect(size({ viewBox: '0 0 24 24', style: 'width:auto' })).toEqual([24, 24]);
        expect(rootLayout({ style: 'width:50%' }).assumed).toEqual(['width', 'height']);
    });

    it('the cascade of the declaration block: invalid ones skipped, !important wins, else the last', () => {
        const width = (style: string): number => size({ viewBox: '0 0 24 24', width: '32', style })[0]!;
        // A unitless nonzero number, a negative length, garbage: invalid CSS, the previous one applies.
        expect(width('width:48px;width:48')).toBe(48);
        expect(width('width:48px;width:-1px')).toBe(48);
        expect(width('width:48px;width:foo')).toBe(48);
        expect(width('width:48')).toBe(32);
        expect(width('width:48px;width:auto')).toBe(32);
        expect(width('width:48px!important;width:auto')).toBe(48);
        expect(width('width:16px;width:48px')).toBe(48);
    });

    it('<style>svg{width:48px}</style> with optimize: true → 48dp (svgo inlines the rule)', () => {
        const source = svg('viewBox="0 0 24 24" width="24"', `<style>svg{width:48px;height:48px}</style>${rect}`);
        expect(dp(source, true)).toEqual(['android:width="48dp"', 'android:height="48dp"']);
    });

    it('a size that cannot be resolved (calc(), var(), ex) is reported; the attribute applies', () => {
        for (const width of ['calc(48px)', 'var(--w)', '3ex'])
            for (const optimize of [true, false]) {
                const source = svg(`viewBox="0 0 24 24" width="24" style="width:${width}"`, rect);
                const { xml, warnings } = convert(source, { optimize });
                expect(xml).toContain('android:width="24dp"');
                expect(warnings).toEqual([
                    {
                        code: 'unsupported-style',
                        message: `style "width: ${width}" on the root <svg> cannot be resolved; ignored.`,
                        node: 'svg',
                    },
                ]);
                expect(conversionError(() => convert(source, { optimize, strict: true })).warning).toEqual(warnings[0]);
            }
    });

    it('a viewport-relative size is reported once, as such', () => {
        const warnings = convert(svg('viewBox="0 0 24 24" style="width:calc(5vw + 1px)"', rect)).warnings;
        expect(warnings.map((w) => w.message)).toEqual([expect.stringContaining('viewport-relative unit')]);
    });
});

// A browser resolves `em` / `rem` on the root against the initial font size, 16 px (`<img>` of the
// SVG in Firefox and Chrome); `ex` / `ch` depend on the font and stay undefined.
describe('font-relative size on the root <svg>', () => {
    const size = (attrs: Record<string, string>) => {
        const { width, height, assumed } = rootLayout(attrs);
        return { width, height, assumed };
    };

    it('5em → 80 dp: em counts 16 px', () => {
        expect(size({ width: '5em', height: '2.5EM' })).toEqual({ width: 80, height: 40, assumed: [] });
        const { xml, warnings } = convert(svg('width="5em" height="5em"', '<rect width="4" height="4"/>'), {
            strict: true,
        });
        expect(warnings).toEqual([]);
        expect(xml).toContain('android:width="80dp"');
        expect(xml).toContain('android:height="80dp"');
        expect(xml).toContain('android:viewportWidth="80"');
    });

    it('rem counts 16 px as well (the root is its own font-size reference)', () => {
        expect(size({ width: '2rem', height: '1e1rem' })).toEqual({ width: 32, height: 160, assumed: [] });
        for (const optimize of [true, false])
            expect(
                convert(svg('width="2rem" height="2rem"', '<rect width="4" height="4"/>'), { optimize }).xml,
            ).toContain('android:width="32dp"');
    });

    it('em with a viewBox: the other dimension follows the viewBox ratio', () => {
        expect(rootLayout({ viewBox: '0 0 10 20', width: '1em' })).toMatchObject({
            width: 16,
            height: 32,
            viewportWidth: 10,
            viewportHeight: 20,
        });
        expect(convert(svg('viewBox="0 0 10 20" height="2em"', '<rect width="4" height="4"/>')).xml).toContain(
            'android:width="16dp"',
        );
    });

    it('a malformed or negative em length still defines no size', () => {
        for (const width of ['em', 'pxem', '5pxem', '5 em', '-1em', '0rem'])
            expect(size({ width, height: '10' }).assumed).toEqual(['width']);
    });

    it('ex / ch define no size: the viewBox, else 24 with the sizeless warning', () => {
        expect(size({ viewBox: '0 0 10 20', width: '3ex' })).toEqual({ width: 10, height: 20, assumed: [] });
        expect(size({ width: '3ex', height: '2ch' })).toEqual({ width: 24, height: 24, assumed: ['width', 'height'] });
        const { xml, warnings } = convert(svg('width="3ex" height="10"', '<rect width="4" height="4"/>'));
        expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute']);
        expect(warnings[0]!.message).toContain('no usable width');
        expect(xml).toContain('android:width="24dp"');
        expect(xml).toContain('android:height="10dp"');
    });
});

describe('transform on the root <svg>', () => {
    it('wpt-outer-svg-transform.svg: renders like its source', () => {
        expectRendersLike(repro('wpt-outer-svg-transform.svg'));
    });

    it('emits the translation on a root <group>', () => {
        const { xml, warnings } = convert(repro('wpt-outer-svg-transform.svg'));
        expect(warnings).toEqual([]);
        expect(xml).toContain('android:translateX="100"');
    });

    // resvg applies a root transform in user space (after the viewBox), browsers in px of the CSS box
    // (SVG 2 / CSS Transforms): the references below model the latter with an untransformed root.
    it('applies in px of the <svg> box, after the viewBox mapping and its origin', () => {
        // 200 px for 20 units: translate(100) moves the content by 10 units, not 100.
        const rect = '<rect x="10" y="10" width="5" height="5" fill="green"/>';
        expectRendersLike(
            svg('width="200" height="200" viewBox="10 10 20 20" transform="translate(100,0)"', rect),
            svg(
                'width="200" height="200"',
                `<g transform="translate(100,0)"><svg width="200" height="200" viewBox="10 10 20 20">${rect}</svg></g>`,
            ),
        );
    });

    it('composes with the aspect-ratio alignment', () => {
        expectRendersLike(
            svg(
                'width="200" height="100" viewBox="0 0 10 10" transform="translate(-20,10) scale(0.5)"',
                '<rect width="10" height="10" fill="green"/><circle cx="5" cy="5" r="3" fill="red"/>',
            ),
            // Centre-origin scale(0.5) of the 200×100 box, written as a centre-origin <g>.
            svg(
                'width="200" height="100"',
                '<g transform="translate(-20,10) translate(100,50) scale(0.5) translate(-100,-50)">' +
                    '<svg width="200" height="100" viewBox="0 0 10 10">' +
                    '<rect width="10" height="10" fill="green"/><circle cx="5" cy="5" r="3" fill="red"/></svg></g>',
            ),
        );
    });

    it('rotates around the centre of the box (transform-origin 50% 50%), not its corner', () => {
        const attrs = { width: '200', height: '100', transform: 'rotate(90)' };
        const m = rootTransform(attrs, rootLayout(attrs))!;
        expect(applyPoint(m, 100, 50).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([100, 50]);
        expectRendersLike(
            svg(
                'width="200" height="100" transform="rotate(90)"',
                '<rect x="80" width="40" height="20" fill="green"/>',
            ),
            svg(
                'width="200" height="100"',
                '<rect x="80" width="40" height="20" fill="green" transform="rotate(90 100 50)"/>',
            ),
        );
    });

    it('is absent for no, an unparseable or an identity transform', () => {
        for (const transform of [undefined, 'none', 'translate(0)']) {
            const attrs = { width: '10', height: '10', ...(transform ? { transform } : {}) };
            expect(rootTransform(attrs, rootLayout(attrs))).toBeNull();
        }
    });

    it('reads the CSS transform, which overrides the attribute (both modes)', () => {
        const rect = '<rect width="6" height="12" fill="green"/>';
        const box = 'viewBox="0 0 12 12" width="24" height="24"';
        // 24 px for 12 units: translate(6px) moves the content by 3 units.
        expectRendersLike(
            svg(`${box} style="transform: translate(6px)"`, rect),
            svg(box, '<rect x="3" width="6" height="12" fill="green"/>'),
        );
        expectRendersLike(
            svg(`${box} transform="scale(2)" style="transform: rotate(30deg)"`, rect),
            svg(box, `<g transform="rotate(30 6 6)">${rect}</g>`),
        );
        for (const optimize of [true, false])
            expect(convert(svg(`${box} style="transform: translate(6px)"`, rect), { optimize }).warnings).toEqual([]);
    });

    it('applies the !important, else the last valid declaration; an invalid one is dropped', () => {
        const attrs = (style: string): Record<string, string> => ({
            width: '10',
            height: '10',
            transform: 'translate(1)',
            style,
        });
        const dx = (style: string): number | undefined => rootTransform(attrs(style), rootLayout(attrs(style)))?.e;
        expect(dx('transform: translate(2px)')).toBe(2);
        expect(dx('transform: translate(2px); transform: translate(3px)')).toBe(3);
        expect(dx('transform: translate(2px) !important; transform: translate(3px)')).toBe(2);
        // A unitless nonzero length or angle is invalid in CSS (only the attribute syntax reads it).
        expect(dx('transform: translate(2px); transform: translate(3)')).toBe(2);
        expect(dx('transform: translate(5)')).toBe(1);
        expect(dx('transform: rotate(30)')).toBe(1);
        expect(dx('transform: nonsense')).toBe(1);
        // CSS grammar (as Chrome): space-separated arguments, a wrong argument count are invalid.
        expect(dx('transform: translate(5px 5px)')).toBe(1);
        expect(dx('transform: scale(2,2,2)')).toBe(1);
        expect(dx('transform: translate(4px); transform: translate(5px 5px)')).toBe(4);
        // `none` and the CSS-wide keywords reset it: no transform at all.
        expect(rootTransform(attrs('transform: none'), rootLayout(attrs('')))).toBeNull();
        expect(rootTransform(attrs('transform: initial'), rootLayout(attrs('')))).toBeNull();
    });

    it('reports a CSS transform it cannot resolve and keeps the attribute', () => {
        for (const value of [
            'translate(50%)',
            'var(--t)',
            'translate(calc(1px + 2px))',
            'translate(1ex)',
            // Valid 3D: Chrome applies it, the converter cannot.
            'rotateX(10deg)',
            'matrix3d(1,0,0,0,0,1,0,0,0,0,2,0,5,5,0,1)',
        ]) {
            const source = svg(
                `width="20" height="20" transform="translate(2)" style="transform: ${value}"`,
                '<rect width="4" height="4"/>',
            );
            for (const optimize of [true, false]) {
                const error = conversionError(() => convert(source, { optimize, strict: 'lossy' }));
                expect([error.warning.code, error.warning.node], value).toEqual(['unsupported-style', 'svg']);
                expect(error.warning.message).toContain(`transform: ${value}`);
                expect(convert(source, { optimize }).xml).toContain('android:translateX="2"');
            }
        }
    });

    it('closes an unclosed function and reads comments as whitespace (as Chrome, both modes)', () => {
        const rect = '<rect width="6" height="12" fill="green"/>';
        const box = 'viewBox="0 0 12 12" width="24" height="24"';
        for (const value of ['rotate(30deg', 'rotate(/*x*/30deg)', 'rotate(30deg /* ) */']) {
            const source = svg(`${box} transform="scale(2)" style="transform: ${value}"`, rect);
            expectRendersLike(source, svg(box, `<g transform="rotate(30 6 6)">${rect}</g>`));
            for (const optimize of [true, false]) expect(convert(source, { optimize }).warnings, value).toEqual([]);
        }
    });

    it('reports a 3D CSS transform with the wording used on other elements', () => {
        const source = svg('width="20" height="20" style="transform: rotateX(10deg)"', '<rect width="4" height="4"/>');
        for (const optimize of [true, false])
            expect(convert(source, { optimize }).warnings.map((w) => w.message)).toEqual([
                'style "transform: rotateX(10deg)" on the root <svg> is not a 2D transform with absolute units; ignored.',
            ]);
    });

    it('drops an invalid CSS transform silently and keeps the attribute (as Chrome, both modes)', () => {
        for (const value of ['translate(5px 5px)', 'translate(5)', 'banana']) {
            const source = svg(
                `width="20" height="20" transform="translate(2)" style="transform: ${value}"`,
                '<rect width="4" height="4"/>',
            );
            for (const optimize of [true, false]) {
                const { xml, warnings } = convert(source, { optimize, strict: 'lossy' });
                expect(warnings, value).toEqual([]);
                expect(xml, value).toContain('android:translateX="2"');
                expect(xml, value).not.toContain('android:translateX="5"');
            }
        }
    });
});

/** The root `<svg>` element of `source`, as the converter sees it. */
const rootSvg = (source: string, optimize = true): XastElement =>
    (parseSvg(source, optimize, undefined, 3).children ?? []).find(
        (c): c is XastElement => c.type === 'element' && c.name === 'svg',
    )!;

describe('viewport-relative units on an <svg>', () => {
    it('wpt nested-svg-sizing-viewport-units: style="width:5vw" on a nested <svg> is reported', () => {
        const source = svg(
            'width="100" height="100"',
            '<svg style="width:5vw;height:5vh;"><circle cx="50" cy="50" r="40" fill="green"/></svg>',
        );
        for (const optimize of [true, false]) {
            const warnings = layoutWarnings(rootSvg(source, optimize));
            expect(warnings.map((w) => [w.code, w.node])).toEqual([
                ['unsupported-style', 'svg'],
                ['unsupported-style', 'svg'],
            ]);
            expect(warnings[0]!.message).toContain('width: 5vw');
            expect(warnings[0]!.message).toContain('browser window');
        }
    });

    it('the width="5vw" attribute on a nested <svg> is reported (read as 100%)', () => {
        const source = svg(
            'width="100" height="100"',
            '<svg width="5vw" x="2vmin"><rect width="10" height="10"/></svg>',
        );
        for (const optimize of [true, false]) {
            const warnings = layoutWarnings(rootSvg(source, optimize));
            expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute', 'unsupported-attribute']);
            expect(warnings.map((w) => w.message)).toEqual([
                expect.stringMatching(/^x="2vmin" on a nested <svg>.*read as 0\.$/),
                expect.stringMatching(/^width="5vw" on a nested <svg>.*read as 100%\.$/),
            ]);
        }
    });

    it('the root <svg> is checked too (width / height, attribute or style)', () => {
        const warnings = layoutWarnings(
            rootSvg(svg('width="5vw" style="height: 10vh" viewBox="0 0 10 10"', '<rect width="10" height="10"/>')),
        );
        expect(warnings.map((w) => w.code)).toEqual(['unsupported-attribute', 'unsupported-style']);
        expect(warnings[0]!.message).toContain('on the root <svg>');
    });

    it('recognizes every viewport-relative unit, in calc() too, and nothing else', () => {
        for (const width of [
            '5vh',
            '5VW',
            '1vmin',
            '1vmax',
            '2vi',
            '2vb',
            '3svh',
            '3lvw',
            '3dvmax',
            '4cqw',
            'calc(5vw + 1px)',
        ])
            expect(
                layoutWarnings(rootSvg(svg('width="10" height="10"', `<svg width="${width}"/>`), false)),
            ).toHaveLength(1);
        for (const width of ['5', '5px', '1em', '2rem', '50%', '1in'])
            expect(layoutWarnings(rootSvg(svg('width="10" height="10"', `<svg width="${width}"/>`), false))).toEqual(
                [],
            );
    });

    it('reports a repeated case once', () => {
        const nested = '<svg width="5vw"><rect width="1" height="1"/></svg>';
        expect(layoutWarnings(rootSvg(svg('width="10" height="10"', nested + nested), false))).toHaveLength(1);
    });
});

describe('CSS size of a nested <svg>', () => {
    /** The nested `<svg>` of a 100×100 root, as the converter sees it. */
    const nested = (attrs: string): XastElement =>
        (
            rootSvg(svg('width="100" height="100"', `<svg ${attrs}><rect width="10" height="10"/></svg>`), false)
                .children ?? []
        ).find((c): c is XastElement => c.type === 'element' && c.name === 'svg')!;
    const vp = { width: 100, height: 100 };

    // svgwg PR 1059 / WPT styling/nested-svg-sizing*.svg: the CSS properties do not apply to a
    // nested <svg>, only its attributes do.
    it('ignores x / y / width / height declarations: the attributes (or 0 / 100%) apply', () => {
        const layout = nestedLayout(nested('width="80" style="width:50px; height: 25px; x: 10px"'), vp)!;
        expect([layout.x, layout.y, layout.width, layout.height]).toEqual([0, 0, 80, 100]);
        expect(nestedLayout(nested('width="80" style="width:0"'), vp)).not.toBeNull();
    });

    it('style="width:50px" renders like the attributes alone, without a warning', () => {
        const body = (attrs: string): string =>
            `<rect width="100" height="100" fill="blue"/><svg ${attrs} viewBox="0 0 10 10">` +
            '<rect width="10" height="10" fill="green"/></svg>';
        const source = svg('width="100" height="100"', body('width="80" style="width:50px;height:50px"'));
        expectRendersLike(source, svg('width="100" height="100"', body('width="80"')));
        expect(convert(source).warnings).toEqual([]);
    });
});

describe('transform-origin on the root <svg>', () => {
    const at = (value: string): [number, number] | null => {
        const o = parseTransformOrigin(value, { width: 200, height: 100 });
        return o && [o.x, o.y];
    };

    it('resolves keywords (either order), percentages and lengths against the width×height box', () => {
        expect(at('left top')).toEqual([0, 0]);
        expect(at('top left')).toEqual([0, 0]);
        expect(at('bottom right')).toEqual([200, 100]);
        expect(at('center')).toEqual([100, 50]);
        expect(at('top')).toEqual([100, 0]);
        expect(at('right')).toEqual([200, 50]);
        expect(at('25% 10%')).toEqual([50, 10]);
        expect(at('10px')).toEqual([10, 50]);
        expect(at('10 1em 0')).toEqual([10, 16]);
        expect(at('right 20px 5px')).toEqual([200, 20]);
    });

    it('is null for an invalid or unresolvable value', () => {
        for (const value of ['', 'top 10px', 'left right', 'top bottom', '1ex', '5vw 0', '0 0 5%', '1 2 3 4', 'middle'])
            expect(at(value)).toBeNull();
    });

    it('the transform turns around the transform-origin attribute', () => {
        const attrs = { width: '200', height: '100', transform: 'scale(0.5)', 'transform-origin': 'right bottom' };
        const m = rootTransform(attrs, rootLayout(attrs))!;
        expect(applyPoint(m, 200, 100)).toEqual([200, 100]);
        expectRendersLike(
            svg(
                'width="200" height="100" transform="scale(0.5)" transform-origin="right bottom"',
                '<rect width="200" height="100" fill="green"/><circle cx="50" cy="50" r="30" fill="red"/>',
            ),
            svg(
                'width="200" height="100"',
                '<g transform="translate(200,100) scale(0.5) translate(-200,-100)">' +
                    '<rect width="200" height="100" fill="green"/><circle cx="50" cy="50" r="30" fill="red"/></g>',
            ),
        );
    });

    it('in px of the box, through the viewBox mapping', () => {
        const attrs = {
            width: '200',
            height: '100',
            viewBox: '0 0 20 10',
            transform: 'rotate(90)',
            'transform-origin': '50 50',
        };
        const m = rootTransform(attrs, rootLayout(attrs))!;
        // The px origin (50, 50) is (5, 5) in viewport units: a fixed point of the rotation.
        expect(applyPoint(m, 5, 5).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([5, 5]);
        expectRendersLike(
            svg(
                'width="200" height="100" viewBox="0 0 20 10" transform="rotate(90)" transform-origin="50 50"',
                '<rect x="8" width="4" height="2" fill="green"/>',
            ),
            svg(
                'width="200" height="100" viewBox="0 0 20 10"',
                '<rect x="8" width="4" height="2" fill="green" transform="rotate(90 5 5)"/>',
            ),
        );
    });

    it('an unresolvable one falls back to the centre and is reported', () => {
        const attrs = { width: '200', height: '100', transform: 'rotate(90)', 'transform-origin': '1ex 0' };
        const m = rootTransform(attrs, rootLayout(attrs))!;
        expect(applyPoint(m, 100, 50).map((v) => Math.round(v * 1e9) / 1e9)).toEqual([100, 50]);
        const source = svg(
            'width="200" height="100" transform="rotate(90)" transform-origin="1ex 0"',
            '<rect width="4" height="4"/>',
        );
        for (const optimize of [true, false]) {
            const warnings = layoutWarnings(rootSvg(source, optimize));
            expect(warnings.map((w) => [w.code, w.node])).toEqual([['unsupported-attribute', 'svg']]);
            expect(warnings[0]!.message).toContain('transform-origin="1ex 0"');
        }
    });

    it('the CSS transform-origin overrides the attribute; an invalid one is dropped', () => {
        const attrs = (style: string): Record<string, string> => ({
            width: '200',
            height: '100',
            transform: 'scale(0.5)',
            'transform-origin': 'right bottom',
            style,
        });
        const fixed = (style: string): [number, number] => {
            const m = rootTransform(attrs(style), rootLayout(attrs(style)))!;
            // The fixed point of a scale(0.5) around (x, y) is (x, y): m(p) = p / 2 + o / 2.
            return [m.e * 2, m.f * 2];
        };
        expect(fixed('transform-origin: 0 0')).toEqual([0, 0]);
        expect(fixed('transform-origin: 10px 20px')).toEqual([10, 20]);
        expect(fixed('transform-origin: left top; transform-origin: 10 20')).toEqual([0, 0]);
        expect(fixed('transform-origin: 10 20')).toEqual([200, 100]);
        expect(fixed('transform-origin: initial')).toEqual([100, 50]);
        expectRendersLike(
            svg(
                'width="200" height="100" transform="rotate(90)" transform-origin="50 50" style="transform-origin: 0 0"',
                '<rect y="-20" width="100" height="20" fill="green"/>',
            ),
            svg(
                'width="200" height="100"',
                '<rect y="-20" width="100" height="20" fill="green" transform="rotate(90)"/>',
            ),
        );
    });

    it('reads a CSS transform-origin minified by csso (`50%0`, `10%top`): same output in both modes', () => {
        const attrs = (origin: string): Record<string, string> => ({
            width: '40',
            height: '20',
            style: `transform: rotate(90deg); transform-origin: ${origin}`,
        });
        const at = (origin: string): Matrix => rootTransform(attrs(origin), rootLayout(attrs(origin)))!;
        expect(at('50%0')).toEqual(at('50% 0'));
        expect(at('10%top')).toEqual(at('10% top'));
        expect(at('50%0')).not.toEqual(at('50% 50%'));
        for (const [origin, translate] of [
            ['50% 0', 'android:translateX="20" android:translateY="-20"'],
            ['10% top', 'android:translateX="4" android:translateY="-4"'],
        ] as const) {
            const source = svg(
                `width="40" height="20" style="transform: rotate(90deg); transform-origin: ${origin}"`,
                '<rect width="40" height="10" fill="green"/>',
            );
            for (const optimize of [true, false]) {
                const { xml, warnings } = convert(source, { optimize });
                // The path data is written differently by mode; the root group is the same.
                expect(xml.replace(/\s+/g, ' ').match(/<group [^>]*>/)?.[0], `optimize: ${optimize}`).toBe(
                    `<group ${translate} android:rotation="90">`,
                );
                expect(warnings).toEqual([]);
            }
        }
    });

    it('reports a CSS transform-origin it cannot resolve, then reads the attribute', () => {
        const source = svg(
            'width="200" height="100" transform="rotate(90)" transform-origin="0 0" style="transform-origin: 1ex 0"',
            '<rect width="4" height="4"/>',
        );
        for (const optimize of [true, false]) {
            const warnings = layoutWarnings(rootSvg(source, optimize));
            expect(warnings.map((w) => [w.code, w.node])).toEqual([['unsupported-style', 'svg']]);
            expect(warnings[0]!.message).toContain('transform-origin: 1ex 0');
        }
        const attrs = { width: '200', height: '100', transform: 'rotate(90)', 'transform-origin': '0 0' };
        expect(rootTransform({ ...attrs, style: 'transform-origin: 1ex 0' }, rootLayout(attrs))).toEqual(
            rootTransform(attrs, rootLayout(attrs)),
        );
    });

    it('is not reported without a transform to apply it to', () => {
        for (const transform of ['', 'transform="translate(0)"'])
            expect(
                layoutWarnings(rootSvg(svg(`width="20" height="20" ${transform} transform-origin="1ex"`, '<rect/>'))),
            ).toEqual([]);
    });
});

describe('convert() reports viewport-relative units on <svg>', () => {
    it('rejects width="5vw" on the root under strict, in both modes', () => {
        const doc =
            '<svg xmlns="http://www.w3.org/2000/svg" width="5vw" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
        for (const optimize of [true, false]) {
            expect(() => convert(doc, { optimize, strict: 'lossy' })).toThrow(/vw/);
        }
    });
});

// Chrome and Firefox (inline <svg>) resolve these: `width="3ex"` → 22 px (Chrome) / 25.75 px
// (Firefox), `width="calc(10px + 2em)"` → 42 px; the converter takes the viewBox size instead.
describe('root width / height attribute that cannot be resolved, under a viewBox', () => {
    const rect = '<rect width="24" height="24" fill="green"/>';

    it('3ex and calc(10px + 2em) → one unsupported-attribute, both modes; strict throws', () => {
        for (const width of ['3ex', 'calc(10px + 2em)'])
            for (const optimize of [true, false]) {
                const source = svg(`width="${width}" height="48" viewBox="0 0 24 24"`, rect);
                const { xml, warnings } = convert(source, { optimize });
                expect(xml).toContain('android:width="48dp"');
                expect(warnings).toEqual([
                    {
                        code: 'unsupported-attribute',
                        message: `width="${width}" on the root <svg> cannot be resolved; ignored, the size follows the viewBox.`,
                        node: 'svg',
                    },
                ]);
                expect(conversionError(() => convert(source, { optimize, strict: true })).warning).toEqual(warnings[0]);
            }
    });

    it('height is checked too, once per message', () => {
        const source = svg('width="2ch" height="var(--h)" viewBox="0 0 24 24"', rect);
        expect(layoutWarnings(parseSvg(source, false).children[0] as XastElement).map((w) => w.message)).toEqual([
            'width="2ch" on the root <svg> cannot be resolved; ignored, the size follows the viewBox.',
            'height="var(--h)" on the root <svg> cannot be resolved; ignored, the size follows the viewBox.',
        ]);
    });

    it('48, 48px, abc, 100%, auto, -3ex → no warning, both modes', () => {
        for (const width of ['48', '48px', 'abc', '100%', 'auto', '-3ex'])
            for (const optimize of [true, false])
                expect(
                    convert(svg(`width="${width}" height="48" viewBox="0 0 24 24"`, rect), { optimize, strict: true })
                        .warnings,
                ).toEqual([]);
    });

    it('a CSS width that sets the size overrides the attribute: no warning', () => {
        for (const optimize of [true, false])
            expect(
                convert(svg('width="3ex" style="width:48px" viewBox="0 0 24 24"', rect), { optimize, strict: true })
                    .warnings,
            ).toEqual([]);
    });

    it('without a viewBox, only the sizeless-root warning', () => {
        const { warnings } = convert(svg('width="3ex" height="10"', rect));
        expect(warnings.map((w) => w.message)).toEqual([expect.stringContaining('no usable width')]);
    });
});

describe('root viewBox magnified by its size', () => {
    const tiny = (body: string, viewBox = '0 0 0.024 0.024'): string =>
        svg(`width="24" height="24" viewBox="${viewBox}"`, body);
    const rect = '<rect x="0.00123" y="0.00123" width="0.0104" height="0.0104" fill="green"/>';

    it('viewBox="0 0 0.024 0.024" at 24 px keeps the decimals the factor of 1000 needs, both modes', () => {
        expectRendersLike(tiny(rect));
        for (const optimize of [true, false]) {
            const { xml } = convert(tiny(rect), { optimize });
            expect(xml).toMatch(/pathData="M0?\.00123,?0?\.00123h0?\.0104/);
        }
    });

    it('the viewport, its offset and a clip-path keep them too', () => {
        const source = tiny(
            `<clipPath id="c"><rect x="0.0101" y="0.0101" width="0.0102" height="0.0102"/></clipPath>` +
                `<circle clip-path="url(#c)" cx="0.0152" cy="0.0152" r="0.0081" fill="green"/>`,
            '0.00051 0.00051 0.0245 0.0245',
        );
        expectRendersLike(source);
        for (const optimize of [true, false]) {
            const { xml } = convert(source, { optimize });
            expect(xml).toContain('android:viewportWidth="0.0245"');
            expect(xml).toContain('android:translateX="-0.00051"');
            expect(xml).toMatch(/clip-path android:pathData="M0?\.0101,?0?\.0101h0?\.0102/);
        }
    });

    it('a factor of 10 or less, viewBox="0 0 24 24" and "0 0 1 1" at 24 px: output unchanged', () => {
        const cases: [viewBox: string, body: string, optimized: string, unoptimized: string][] = [
            [
                '0 0 24 24',
                '<rect x="1.23456" y="2" width="10" height="10"/>',
                'M1.235 2h10v10h-10z',
                'M1.235,2h10v10h-10z',
            ],
            [
                '0 0 2.4 2.4',
                '<rect x="0.123456" y="0.2" width="1" height="1"/>',
                'M.123.2h1v1h-1z',
                'M0.123,0.2h1v1h-1z',
            ],
            [
                '0 0 1 1',
                '<rect x="0.123" y="0.2" width="0.4" height="0.4"/>',
                'M.123.2h.4v.4h-.4z',
                'M0.123,0.2h0.4v0.4h-0.4z',
            ],
        ];
        for (const [viewBox, body, optimized, unoptimized] of cases) {
            const source = svg(`width="24" height="24" viewBox="${viewBox}"`, body);
            expect(convert(source, { optimize: false }).xml).toContain(`android:pathData="${unoptimized}"`);
            expect(convert(source, { optimize: true }).xml).toContain(`android:pathData="${optimized}"`);
        }
    });
});
