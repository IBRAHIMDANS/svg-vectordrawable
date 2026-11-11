import { Resvg } from '@resvg/resvg-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DENSITIES, renderFallbackPng, type Density } from '../src/fallback.js';

const BLUR =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><filter id="f"><feGaussianBlur stdDeviation="1"/></filter><circle cx="12" cy="12" r="8" fill="#1A73E8" filter="url(#f)"/></svg>';

/** Width and height of a PNG, from its IHDR chunk. */
const size = (png: Buffer): [number, number] => [png.readUInt32BE(16), png.readUInt32BE(20)];

/** resvg's own render of `svg` at `zoom`, the reference. */
const resvg = (svg: string, zoom = 1): Buffer =>
    new Resvg(svg, { fitTo: { mode: 'zoom', value: zoom }, font: { loadSystemFonts: false } }).render().asPng();

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

    it('rejects an unknown density, an invalid size and an invalid SVG', () => {
        expect(() => renderFallbackPng(BLUR, { density: 'ldpi' as Density })).toThrow(TypeError);
        expect(() => renderFallbackPng(BLUR, { width: 0 })).toThrow('Invalid width');
        expect(() => renderFallbackPng(BLUR, { height: Number.NaN })).toThrow('Invalid height');
        expect(() => renderFallbackPng('<svg viewBox="0 0 0 24"/>')).toThrow('Invalid viewBox');
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
