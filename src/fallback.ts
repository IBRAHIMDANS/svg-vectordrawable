import { createRequire } from 'node:module';
import type { XastElement, XastRoot } from './ast.js';
import { vectorSize } from './convert.js';
import { prepareSource } from './normalize.js';
import { styleDeclarations } from './style.js';
import { optimize } from './svgo.js';
import { formatMatrix } from './transform.js';
import { disablingViewBox, rootLayout, rootTransform } from './viewport.js';

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
 * the drawable's, `width` / `height` overrides included (`convert`'s `vectorSize`). A root
 * transform (attribute or CSS, `rootTransform`) is moved onto a `<g>` around the content, with the
 * browser semantics `convert` uses. A viewBox that disables rendering gives an empty image.
 */
function sizeRoot(root: XastRoot, scale: number, width?: number, height?: number): void {
    const svg = root.children.find((c): c is XastElement => c.type === 'element' && c.name === 'svg');
    if (!svg) throw new Error('No <svg> root element found');
    const attrs = (svg.attributes ??= {});
    // resvg reads namespaces, svgo and convert do not: a root without any declaration (prepareSource
    // gives a prefixed `<ns0:svg>` its default one) needs the SVG namespace to be found.
    attrs.xmlns ??= 'http://www.w3.org/2000/svg';
    // A zero or negative viewBox width or height disables rendering (SVG 2 §8.6): as convert does, an
    // empty image sized as if the viewBox were absent.
    if (disablingViewBox(attrs) !== undefined) {
        delete attrs.viewBox;
        svg.children = [];
    }
    const layout = rootLayout(attrs);
    const size = vectorSize(layout, width, height);
    attrs.width = String(Math.max(1, Math.round(size.width * scale)));
    attrs.height = String(Math.max(1, Math.round(size.height * scale)));
    attrs.preserveAspectRatio = 'none';
    // Browsers and convert apply a root transform (CSS property over attribute) in px of the CSS box
    // around transform-origin; resvg would apply the attribute in user units around (0,0), and a CSS
    // one written in the attribute syntax (`translate(3)`, invalid CSS). Drop both and wrap the
    // content in the matrix convert uses (it carries the layout offset, so the viewBox starts at 0,0;
    // null when nothing applies, e.g. `transform: none` over the attribute).
    const matrix = rootTransform(attrs, layout);
    delete attrs.transform;
    delete attrs['transform-origin'];
    const declarations = styleDeclarations(attrs.style);
    const kept = declarations.filter(([name]) => name !== 'transform' && name !== 'transform-origin');
    if (kept.length !== declarations.length) {
        if (kept.length) attrs.style = kept.map(([k, v, i]) => `${k}:${v}${i ? '!important' : ''}`).join(';');
        else delete attrs.style;
    }
    if (!matrix) {
        attrs.viewBox = `${-layout.offsetX} ${-layout.offsetY} ${layout.viewportWidth} ${layout.viewportHeight}`;
        return;
    }
    attrs.viewBox = `0 0 ${layout.viewportWidth} ${layout.viewportHeight}`;
    svg.children = [
        { type: 'element', name: 'g', attributes: { transform: formatMatrix(matrix) }, children: svg.children ?? [] },
    ];
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
    // svgo as a plain parser / serializer: only this plugin runs, nothing is optimized. The source is
    // prepared as convert does: numeric references decoded (svgo's parser caps them at 512) and an
    // SVG-namespace prefix dropped (`<ns0:svg>`, otherwise no `<svg>` root is found).
    const plugin = {
        name: 'svgvd-fallback-size',
        fn: (root: unknown) => {
            sizeRoot(root as XastRoot, DENSITIES[density], width, height);
            return {};
        },
    };
    let sized: string;
    try {
        sized = optimize(prepareSource(svg), { plugins: [plugin] }).data;
    } catch (err) {
        throw new Error(`Invalid SVG: ${(err as Error).message}`, { cause: err });
    }
    const { Resvg } = loadResvg();
    return new Resvg(sized, { fitTo: { mode: 'original' }, font: { loadSystemFonts: hasText(svg) } }).render().asPng();
}
