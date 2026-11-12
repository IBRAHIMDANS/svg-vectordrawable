import { Resvg } from '@resvg/resvg-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DENSITIES, renderFallbackPng, type Density } from '../src/fallback.js';
import { convert, vectorDrawableToSvg } from '../src/index.js';
import { compareRasters, DEFAULT_MAX_MISMATCH, renderSvg } from './visual/compare.js';

const BLUR =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><filter id="f"><feGaussianBlur stdDeviation="1"/></filter><circle cx="12" cy="12" r="8" fill="#1A73E8" filter="url(#f)"/></svg>';

/** Width and height of a PNG, from its IHDR chunk. */
const size = (png: Buffer): [number, number] => [png.readUInt32BE(16), png.readUInt32BE(20)];

/** resvg's own render of `svg` at `zoom`, the reference. */
const resvg = (svg: string, zoom = 1): Buffer =>
    new Resvg(svg, { fitTo: { mode: 'zoom', value: zoom }, font: { loadSystemFonts: false } }).render().asPng();

/** A PNG as a raster comparable with `renderSvg`'s (drawn 1:1 by resvg). */
const raster = (png: Buffer): ReturnType<typeof renderSvg> => {
    const [w, h] = size(png);
    const href = `data:image/png;base64,${png.toString('base64')}`;
    return renderSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><image width="${w}" height="${h}" href="${href}"/></svg>`,
        w,
    );
};

describe('renderFallbackPng', () => {
    it('renders the dp size times the density scale of each Android bucket', () => {
        const sizes = (Object.keys(DENSITIES) as Density[]).map((density) =>
            size(renderFallbackPng(BLUR, { density })),
        );
        expect(sizes).toEqual([
            [24, 24],
            [36, 36],
            [48, 48],
            [72, 72],
            [96, 96],
        ]);
    });

    it('defaults to mdpi and renders like resvg (filters included)', () => {
        expect(renderFallbackPng(BLUR)).toEqual(resvg(BLUR));
        expect(renderFallbackPng(BLUR, { density: 'xxhdpi' })).toEqual(resvg(BLUR, 3));
    });

    it('takes the size of the <vector>: width / height attributes, units, and the viewBox ratio', () => {
        const svg = (attrs: string): string =>
            `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect width="10" height="10"/></svg>`;
        expect(size(renderFallbackPng(svg('width="48" height="32" viewBox="0 0 24 24"')))).toEqual([48, 32]);
        expect(size(renderFallbackPng(svg('width="1in" viewBox="0 0 48 24"')))).toEqual([96, 48]);
        expect(size(renderFallbackPng(svg('height="12" viewBox="0 0 48 24"'), { density: 'hdpi' }))).toEqual([36, 18]);
        // No viewBox: the size in px, the content in px too, so it scales with the density.
        const bare = svg('width="20" height="10"');
        expect(renderFallbackPng(bare, { density: 'xhdpi' })).toEqual(
            renderFallbackPng(svg('width="20" height="10" viewBox="0 0 20 10"'), { density: 'xhdpi' }),
        );
        // Neither: 24×24, as convert assumes (and reports).
        expect(size(renderFallbackPng(svg('')))).toEqual([24, 24]);
    });

    it('keeps preserveAspectRatio when the size and the viewBox ratios differ', () => {
        for (const par of ['', 'xMinYMax meet', 'xMidYMid slice', 'none']) {
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24" viewBox="-4 2 24 24" preserveAspectRatio="${par}"><circle cx="8" cy="14" r="12" fill="#1A73E8"/></svg>`;
            expect(renderFallbackPng(svg, { density: 'xhdpi' }), par).toEqual(resvg(svg, 2));
        }
    });

    it('applies the width / height options like convert: alone the ratio is kept, both stretch', () => {
        const wide = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"><rect width="48" height="24"/></svg>';
        expect(size(renderFallbackPng(wide, { width: 24 }))).toEqual([24, 12]);
        expect(size(renderFallbackPng(wide, { height: 48, density: 'hdpi' }))).toEqual([144, 72]);
        expect(size(renderFallbackPng(wide, { width: 10, height: 10, density: 'xhdpi' }))).toEqual([20, 20]);
        // Stretched like the <vector>'s viewport (Android), not letterboxed.
        expect(renderFallbackPng(wide, { width: 10, height: 10, density: 'xhdpi' })).toEqual(
            resvg(wide.replace('<svg ', '<svg width="10" height="10" preserveAspectRatio="none" '), 2),
        );
    });

    it('applies a root transform like convert (and browsers): in px of the CSS box, around transform-origin', () => {
        const svg = (attrs: string): string =>
            `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect x="1" y="2" width="6" height="4" fill="#1A73E8"/><circle cx="9" cy="8" r="2.5" fill="#E8711A"/></svg>`;
        const cases = [
            svg('viewBox="0 0 12 12" width="24" height="24" transform="rotate(30)"'),
            svg('viewBox="0 0 12 12" width="24" height="24" transform="translate(6)"'),
            svg(
                'viewBox="-2 1 12 12" width="36" height="24" transform="rotate(-20) scale(0.8)" transform-origin="0 0"',
            ),
            // The CSS property overrides the attribute, the CSS origin too.
            svg('viewBox="0 0 12 12" width="24" height="24" style="transform: translate(6px)"'),
            svg('viewBox="0 0 12 12" width="24" height="24" transform="scale(2)" style="transform: rotate(30deg)"'),
            svg('viewBox="0 0 12 12" width="24" height="24" transform="rotate(90)" style="transform-origin: 0 0"'),
        ];
        for (const source of cases) {
            const drawable = vectorDrawableToSvg(convert(source).xml);
            for (const density of ['mdpi', 'xhdpi'] as const) {
                const png = raster(renderFallbackPng(source, { density }));
                const result = compareRasters(renderSvg(drawable, png.width), png);
                expect(result.mismatch, `${density} ${source}`).toBeLessThan(DEFAULT_MAX_MISMATCH);
            }
        }
    });

    it('reads a CSS transform / transform-origin on the root as convert does: same bytes as the attributes', () => {
        const svg = (attrs: string): string =>
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="24" height="24" ${attrs}><rect width="6" height="12" fill="#1A73E8"/></svg>`;
        const pairs = [
            ['style="transform: translate(6px)"', 'transform="translate(6)"'],
            ['transform="scale(3)" style="transform: rotate(30deg)"', 'transform="rotate(30)"'],
            ['transform="rotate(90)" style="transform-origin: 0 0"', 'transform="rotate(90)" transform-origin="0 0"'],
            // An invalid declaration (unitless length, garbage) is dropped: the attribute applies.
            ['transform="translate(6)" style="transform: translate(3)"', 'transform="translate(6)"'],
            ['transform="translate(6)" style="transform: bogus(1px)"', 'transform="translate(6)"'],
            ['transform="rotate(90)" style="transform-origin: 6 6"', 'transform="rotate(90)"'],
            // `none` overrides the attribute.
            ['transform="translate(6)" style="transform: none"', ''],
        ];
        for (const [css, attribute] of pairs) {
            for (const density of ['mdpi', 'xhdpi'] as const)
                expect(renderFallbackPng(svg(css!), { density }), `${density} ${css}`).toEqual(
                    renderFallbackPng(svg(attribute!), { density }),
                );
            for (const optimize of [true, false])
                expect(convert(svg(css!), { optimize }), `${optimize} ${css}`).toEqual(
                    convert(svg(attribute!), { optimize }),
                );
        }
    });

    it('reads a minified root transform-origin (`50%0`, as csso writes it) like the spaced one', () => {
        const svg = (style: string): string =>
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12" width="24" height="24" transform="rotate(90)" style="${style}"><rect width="6" height="12" fill="#1A73E8"/></svg>`;
        for (const density of ['mdpi', 'xhdpi'] as const) {
            const spaced = renderFallbackPng(svg('transform-origin: 50% 0'), { density });
            expect(renderFallbackPng(svg('transform-origin:50%0'), { density }), density).toEqual(spaced);
            // Not dropped: the default origin (the center) renders otherwise.
            expect(renderFallbackPng(svg(''), { density }), density).not.toEqual(spaced);
        }
    });

    it('renders a root <svg> without any xmlns like one with the SVG namespace', () => {
        const body =
            '<rect x="2" y="4" width="20" height="16" fill="#1A73E8"/><circle cx="12" cy="12" r="5" fill="#E8711A"/>';
        const withNs = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${body}</svg>`;
        const withoutNs = `<svg viewBox="0 0 24 24">${body}</svg>`;
        for (const density of ['mdpi', 'xhdpi'] as const)
            expect(renderFallbackPng(withoutNs, { density }), density).toEqual(renderFallbackPng(withNs, { density }));
    });

    it('renders an empty image for a viewBox that disables rendering, sized as convert does', () => {
        const source =
            '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 0 10"><rect width="20" height="10"/></svg>';
        const png = renderFallbackPng(source, { density: 'xhdpi' });
        expect(size(png)).toEqual([40, 20]);
        expect(png).toEqual(resvg('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>', 2));
        expect(convert(source).xml).toContain('android:width="20dp"');
    });

    it('prepares the source as convert does: over 512 numeric references, an SVG-namespace prefix', () => {
        const body =
            '<filter id="f"><feGaussianBlur stdDeviation="1"/></filter><circle cx="12" cy="12" r="8" fill="#1A73E8" filter="url(#f)"/>';
        const plain = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>${'é'.repeat(600)}</title>${body}</svg>`;
        // svgo's parser rejects more than 512 references; the fill one is decoded too.
        const references = plain.replaceAll('é', '&#xe9;').replace('#1A73E8', '&#35;1A73E8');
        const prefixed = plain
            .replace('<svg xmlns=', '<ns0:svg xmlns:ns0=')
            .replace('</svg>', '</ns0:svg>')
            .replace(/<(\/?)(?!svg|ns0)(\w+)/g, '<$1ns0:$2');
        expect(prefixed).toContain('<ns0:feGaussianBlur');
        for (const density of ['mdpi', 'xhdpi'] as const) {
            const expected = renderFallbackPng(plain, { density });
            expect(renderFallbackPng(references, { density }), `${density} references`).toEqual(expected);
            expect(renderFallbackPng(prefixed, { density }), `${density} prefixed`).toEqual(expected);
        }
        for (const optimize of [true, false])
            for (const source of [references, prefixed])
                expect(convert(source, { optimize }).xml).toEqual(convert(plain, { optimize }).xml);
    });

    it('rejects an unknown density, an invalid size and an invalid SVG', () => {
        expect(() => renderFallbackPng(BLUR, { density: 'ldpi' as Density })).toThrow(TypeError);
        expect(() => renderFallbackPng(BLUR, { width: 0 })).toThrow('Invalid width');
        expect(() => renderFallbackPng(BLUR, { height: Number.NaN })).toThrow('Invalid height');
        expect(() => renderFallbackPng('<g/>')).toThrow('No <svg> root element found');
    });

    describe('without @resvg/resvg-js', () => {
        afterEach(() => {
            vi.doUnmock('node:module');
            vi.resetModules();
        });

        it('fails with a one-line message saying how to install it', async () => {
            vi.resetModules();
            vi.doMock('node:module', async (importOriginal) => ({
                ...(await importOriginal<typeof import('node:module')>()),
                createRequire: () => (id: string) => {
                    throw Object.assign(new Error(`Cannot find module '${id}'\nRequire stack:\n- x`), {
                        code: 'MODULE_NOT_FOUND',
                    });
                },
            }));
            const fallback = await import('../src/fallback.js');
            expect(() => fallback.renderFallbackPng(BLUR)).toThrow(
                /^The PNG fallback needs @resvg\/resvg-js, which is not installed: npm install @resvg\/resvg-js$/,
            );
        });
    });
});
