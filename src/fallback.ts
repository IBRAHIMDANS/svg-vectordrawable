import { createRequire } from 'node:module';
import type { XastElement, XastRoot } from './ast.js';
import { optimize } from './svgo.js';
import { rootLayout } from './viewport.js';

/**
 * Android density buckets and their scale from dp to px (mdpi = 160 dpi = 1 px per dp).
 * https://developer.android.com/training/multiscreen/screendensities
 */
export const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 } as const;

export type Density = keyof typeof DENSITIES;

/** Options of {@link renderFallbackPng}. */
export interface FallbackPngOptions {
    /** Density bucket the PNG is rendered for. Default `'mdpi'` (1 px per dp). */
    density?: Density;
    /** Size in dp, as the `width` / `height` options of `convert` (alone, the other follows the ratio). */
    width?: number;
    height?: number;
}

/** The part of `@resvg/resvg-js` used here. */
interface ResvgModule {
    Resvg: new (
        svg: string,
        options?: { fitTo?: { mode: 'original' }; font?: { loadSystemFonts?: boolean } },
    ) => { render: () => { asPng: () => Buffer } };
}

const RESVG = '@resvg/resvg-js';

let resvg: ResvgModule | undefined;

/**
 * Loads `@resvg/resvg-js` on first use: an optional peer dependency, so the converter itself never
 * needs it. Throws a one-line error saying how to install it when it cannot be loaded.
 */
function loadResvg(): ResvgModule {
    if (resvg) return resvg;
    try {
        // Synchronous, so that the CLI and the file helpers stay synchronous.
        resvg = createRequire(import.meta.url)(RESVG) as ResvgModule;
        return resvg;
    } catch (err) {
        const { code, message } = err as NodeJS.ErrnoException;
        if (code === 'MODULE_NOT_FOUND' && message.includes(`'${RESVG}'`))
            throw new Error(`The PNG fallback needs ${RESVG}, which is not installed: npm install ${RESVG}`, {
                cause: err,
            });
        throw new Error(`The PNG fallback could not load ${RESVG}: ${message.split('\n')[0]}`, { cause: err });
    }
}

/** A `width` / `height` option: undefined or a positive finite number of dp. */
function checkDp(name: string, value: number | undefined): void {
    if (value !== undefined && !(Number.isFinite(value) && value > 0))
        throw new TypeError(`Invalid ${name}: ${String(value)} (expected a positive number of dp)`);
}

/**
 * Sets the root `<svg>` to `scale` px per dp of the drawable's size, its viewBox to the viewport the
 * `<vector>` would have (rootLayout: grown or shrunk for preserveAspectRatio, aligned) stretched
 * onto it with `preserveAspectRatio="none"`, as Android stretches a vector's viewport. The size is
 * the drawable's, `width` / `height` overrides included (as `convert`'s `vectorSize`).
 */
function sizeRoot(root: XastRoot, scale: number, width?: number, height?: number): void {
    const svg = root.children.find((c): c is XastElement => c.type === 'element' && c.name === 'svg');
    if (!svg) throw new Error('No <svg> root element found');
    const attrs = (svg.attributes ??= {});
    const layout = rootLayout(attrs);
    const ratio = layout.width / layout.height;
    const dpWidth = width ?? (height === undefined ? layout.width : height * ratio);
    const dpHeight = height ?? (width === undefined ? layout.height : width / ratio);
    attrs.width = String(Math.max(1, Math.round(dpWidth * scale)));
    attrs.height = String(Math.max(1, Math.round(dpHeight * scale)));
    attrs.viewBox = `${-layout.offsetX} ${-layout.offsetY} ${layout.viewportWidth} ${layout.viewportHeight}`;
    attrs.preserveAspectRatio = 'none';
}

/** Whether the SVG has text, the only content needing fonts (loading the system ones is slow). */
const hasText = (svg: string): boolean => /<(?:[\w.-]+:)?text[\s/>]/.test(svg);

/**
 * Renders `svg` to a PNG with resvg, for the Android `density` bucket: the drawable's size in dp
 * (that of the `<vector>` `convert` would emit, `width` / `height` options included) times the
 * density scale, rounded to whole pixels. Meant for the SVGs a VectorDrawable cannot represent
 * (`ConversionError` under `strict`), as a `drawable-<density>/` bitmap. Node only; needs the
 * optional peer dependency `@resvg/resvg-js`, loaded on first call (a clear error when absent).
 * Throws on an invalid SVG or option.
 */
export function renderFallbackPng(svg: string, options: FallbackPngOptions = {}): Buffer {
    const { density = 'mdpi', width, height } = options;
    if (!Object.hasOwn(DENSITIES, density))
        throw new TypeError(
            `Invalid density: ${JSON.stringify(density)} (expected ${Object.keys(DENSITIES).join(', ')})`,
        );
    checkDp('width', width);
    checkDp('height', height);
    // svgo as a plain parser / serializer: only this plugin runs, nothing is optimized.
    const plugin = {
        name: 'svgvd-fallback-size',
        fn: (root: unknown) => {
            sizeRoot(root as XastRoot, DENSITIES[density], width, height);
            return {};
        },
    };
    let sized: string;
    try {
        sized = optimize(svg, { plugins: [plugin] }).data;
    } catch (err) {
        throw new Error(`Invalid SVG: ${(err as Error).message}`, { cause: err });
    }
    const { Resvg } = loadResvg();
    return new Resvg(sized, { fitTo: { mode: 'original' }, font: { loadSystemFonts: hasText(svg) } }).render().asPng();
}
