import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { convert, ConversionError } from '../src/index.js';
import { applyPoint } from '../src/transform.js';
import { rootLayout, rootTransform } from '../src/viewport.js';
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

    it('a CSS transform on the root is reported, not silently dropped', () => {
        const error = conversionError(() =>
            convert(svg('width="20" height="20" style="transform: translate(5px)"', '<rect width="4" height="4"/>'), {
                strict: 'lossy',
            }),
        );
        expect(error.warning.code).toBe('unsupported-style');
    });
});
