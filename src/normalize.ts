import { optimize } from './svgo.js';
import type { Config } from 'svgo';
import type { XastRoot } from './ast.js';

/**
 * Default normalization: flatten inline `<style>`, turn shapes into paths, bake transforms and
 * collapse trivial groups. This is what lets one walker handle SVGs from any editor.
 * `viewBox` is preserved (svgo 4's preset-default no longer strips it).
 */
const DEFAULT_OVERRIDES = {
    inlineStyles: { onlyMatchedOnce: false },
    convertShapeToPath: { convertArcs: true },
    // svgo 4.1 mis-reflects a smooth `s` that follows a cubic rewritten to `q`
    // (`c3-2 6-2 9 0s6 2 9 0` → wrong first control point). Keep cubics as cubics.
    // `makeArcs` rewrites curves that fit a circle as arcs, then rounds the radius and the end
    // point separately: on a (near) half circle, `a6.999 6.999 0 1 0 0 13.996` puts the centre
    // ~0.12 unit off the chord, since the offset grows as sqrt(r × rounding error). Its
    // threshold / tolerance only bound the fit, not that rounding, so it is turned off.
    convertPathData: { convertToQ: false, makeArcs: false },
    // Keep ids: gradients / clip-paths are referenced by url(#id).
    cleanupIds: { remove: false },
};

/**
 * svgo's `mergePaths` is quadratic: each candidate is intersection-tested against the whole
 * path accumulated so far. Worst case measured (dense, same-style, touching paths): 500 paths
 * ≈ 100 ms, 1,000 ≈ 250 ms, 5,000 ≈ 6.7 s vs 0.3 s without it. Icons sit far below the
 * threshold and keep the merge (fewer `<path>` in the output); large illustrations skip it.
 */
const MERGE_PATHS_MAX_ELEMENTS = 500;

const DRAWABLE_TAG = /<(?:path|rect|circle|ellipse|line|polyline|polygon)[\s/>]/g;
const COMMENT = /<!--[\s\S]*?-->/g;

/** Cheap pre-count of drawable elements, stopping as soon as `limit` is exceeded. */
function exceedsDrawableCount(svg: string, limit: number): boolean {
    const source = svg.includes('<!--') ? svg.replace(COMMENT, '') : svg;
    const tag = new RegExp(DRAWABLE_TAG);
    let count = 0;
    while (tag.exec(source)) {
        if (++count > limit) return true;
    }
    return false;
}

/**
 * svgo's `convertPathData` is quadratic in the number of relative commands of one path, whatever
 * its parameters. Measured on a single path of relative lines: 5,000 segments ≈ 50 ms, 10,000 ≈
 * 0.5 s, 20,000 ≈ 2.5 s, 80,000 ≈ 53 s (61 ms without it). Icons sit far below the threshold and
 * keep the optimization (shorter `pathData`); a document holding a longer `d` is converted as
 * authored, as with `optimize: false`.
 */
const CONVERT_PATH_DATA_MAX_LENGTH = 50_000;

const PATH_DATA_ATTR = /\sd\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** True when some `d` attribute is longer than `limit` characters. */
function exceedsPathDataLength(svg: string, limit: number): boolean {
    if (svg.length <= limit) return false;
    for (const m of svg.matchAll(PATH_DATA_ATTR)) {
        if ((m[1] ?? m[2] ?? '').length > limit) return true;
    }
    return false;
}

/**
 * SVG starts the dash pattern of a `<circle>` / `<ellipse>` at (cx + rx, cy) and runs clockwise.
 * svgo's `convertArcs` rewrites them into paths starting elsewhere, which shifts every dash; keep
 * them as elements (the converter emits them in the SVG direction) whenever dashes may be involved.
 */
const MAY_DASH = /stroke-dasharray/;

/**
 * `pathLength` rescales the dash pattern. svgo follows SVG 1.1, where only `<path>` accepts it:
 * `removeUnknownsAndDefaults` strips it from `<rect>`, `<circle>`… (dashes 1 unit long instead of
 * the authored fraction of the perimeter), and `mergePaths` joins paths that each carry it (the
 * scale then uses the length of the merged path).
 */
const MAY_HAVE_PATH_LENGTH = /\spathLength\s*=/;

/**
 * A negative `width` / `height` / `r` / `rx` / `ry` is an error that disables rendering of the
 * shape (the converter skips it with `empty-path`), but svgo's `convertShapeToPath` turns it into
 * a path that gets drawn. Keep the shapes as elements whenever such a value may be present.
 */
const MAY_HAVE_NEGATIVE_SIZE = /\s(?:width|height|r|rx|ry)\s*=\s*["']\s*-/;

/**
 * A zero `width` / `height` (rect), `r` (circle) or `rx` / `ry` (ellipse) also disables rendering.
 * svgo's `removeHiddenElems` deletes such shapes silently, whereas `optimize: false` reports them
 * with `empty-path` (and `strict` throws). Keep them as elements so both modes warn alike.
 * Element-aware so that the common `<rect rx="0">` does not match.
 */
const MAY_HAVE_ZERO_SIZE =
    /<(?:rect\b[^>]*?\s(?:width|height)|circle\b[^>]*?\sr|ellipse\b[^>]*?\sr[xy])\s*=\s*["']\s*[-+]?(?:0+\.?0*|\.0+)(?:e[-+]?\d+)?(?:px)?\s*["']/i;
/**
 * A missing `r` (circle) or `rx` / `ry` (ellipse) is a zero size too, but `convertShapeToPath`
 * reads it as 0 and emits a bare `M cx cy` path, drawn without any warning.
 */
const MAY_LACK_RADIUS = /<(?:circle\b(?![^>]*\sr\s*=)|ellipse\b(?![^>]*\srx\s*=)|ellipse\b(?![^>]*\sry\s*=))/i;
const ZERO_SIZE_HIDDEN_ELEMS = {
    rectWidth0: false,
    rectHeight0: false,
    circleR0: false,
    ellipseRX0: false,
    ellipseRY0: false,
};

/**
 * A `<path>` without (or with an empty) `d`, a `<polyline>` / `<polygon>` without `points` or with
 * fewer than two points draws nothing either: `optimize: false` reports it with `empty-path`, while
 * svgo deletes it silently (`removeHiddenElems` for a missing `d` / `points` or an empty `d`,
 * `convertShapeToPath` for fewer than four coordinates). Keep them so both modes warn alike.
 */
const MAY_HAVE_EMPTY_GEOMETRY =
    /<(?:path\b(?![^>]*\sd\s*=)|path\b[^>]*?\sd\s*=\s*(["'])\1|poly(?:line|gon)\b(?![^>]*\spoints\s*=)|poly(?:line|gon)\b[^>]*?\spoints\s*=\s*(["'])\s*(?:[^\s,"']+[\s,]*){0,3}\2)/i;
const EMPTY_GEOMETRY_HIDDEN_ELEMS = { pathEmptyD: false, polylineEmptyPoints: false, polygonEmptyPoints: false };

/**
 * svgo's `convertColors` rounds each `rgb()` percentage to an integer channel before the converter
 * sees it (`rgb(20% 50% 50%)` → `#337f7f` instead of `#338080`), whereas the converter keeps the
 * fractional channel until the final rounding. Keep such colors as authored.
 */
const MAY_HAVE_RGB_PERCENT = /rgb\([^)]*%/i;

/**
 * svgo follows SVG 1.1, where `<symbol>` has no `x` / `y` / `width` / `height`:
 * `removeUnknownsAndDefaults` strips them, so a symbol without viewBox loses the viewport it is
 * clipped to (SVG 2). svgo cannot keep attributes per element, so keep the unknown ones throughout.
 */
const MAY_HAVE_SYMBOL_GEOMETRY = /<symbol\b[^>]*?\s(?:x|y|width|height)\s*=/;

/**
 * svgo moves `transform` between groups and their children (`moveElemsAttrsToGroup`,
 * `moveGroupAttrsToElems`, `collapseGroups`) and bakes it into path data (`convertPathData`)
 * without reading the CSS `transform` property nor `transform-origin`, which the converter folds
 * into the attribute after svgo (`applyCssProperties`); `removeNonInheritableGroupAttrs` drops
 * `transform-origin` from groups. Keep the transforms where they are authored when one may be set.
 */
const MAY_HAVE_CSS_TRANSFORM = /(?<![\w-])transform\s*:|transform-(?:origin|box)/;

/**
 * A CSS basic shape in `clip-path` (`inset()`, `circle()`, `ellipse()`, `polygon()`) is laid out on the
 * element's reference box in its own user space: svgo only keeps the transform of an element clipped by
 * a `url()`, and would bake it into the geometry (changing the box). Same guard as a CSS transform.
 */
const MAY_HAVE_CLIP_SHAPE = /clip-path\s*[:=]\s*["']?\s*(?:[a-z-]+\s+)?(?:inset|circle|ellipse|polygon)\(/i;

/** svgo's own default `floatPrecision`: up to it, svgo's rounding is left exactly as it is. */
const SVGO_FLOAT_PRECISION = 3;
/** Above it, svgo's path and transform rounding falls back to `Math.round` (integers). */
const SVGO_MAX_FLOAT_PRECISION = 19;
/** svgo keeps scale / matrix factors 2 decimals finer than coordinates (5 vs 3 by default). */
const TRANSFORM_EXTRA_PRECISION = 2;

function defaultConfigFor(svg: string, floatPrecision: number, fillBlackForUnfilled: boolean): Config {
    const overrides: Record<string, unknown> = { ...DEFAULT_OVERRIDES };
    if (exceedsDrawableCount(svg, MERGE_PATHS_MAX_ELEMENTS)) overrides.mergePaths = false;
    if (exceedsPathDataLength(svg, CONVERT_PATH_DATA_MAX_LENGTH)) overrides.convertPathData = false;
    if (MAY_DASH.test(svg)) {
        overrides.convertShapeToPath = { convertArcs: false };
        // cleanupNumericValues rounds a single-value `stroke-dasharray="0.0001"` to "0", which SVG
        // reads as "no dashes": the stroke would turn solid with no warning. The converter rounds
        // numeric attributes itself, so skipping the plugin only keeps the authored values.
        overrides.cleanupNumericValues = false;
        // pathLength only affects dashes here (markers are not converted).
        if (MAY_HAVE_PATH_LENGTH.test(svg)) {
            overrides.removeUnknownsAndDefaults = { unknownAttrs: false };
            overrides.mergePaths = false;
        }
    }
    if (MAY_HAVE_NEGATIVE_SIZE.test(svg)) overrides.convertShapeToPath = false;
    if (MAY_HAVE_ZERO_SIZE.test(svg)) {
        overrides.convertShapeToPath = false;
        overrides.removeHiddenElems = ZERO_SIZE_HIDDEN_ELEMS;
    }
    if (MAY_LACK_RADIUS.test(svg)) overrides.convertShapeToPath = false;
    if (MAY_HAVE_EMPTY_GEOMETRY.test(svg)) {
        overrides.convertShapeToPath = false;
        overrides.removeHiddenElems = {
            ...(overrides.removeHiddenElems as object | undefined),
            ...EMPTY_GEOMETRY_HIDDEN_ELEMS,
        };
    }
    if (MAY_HAVE_RGB_PERCENT.test(svg)) overrides.convertColors = { rgb2hex: false };
    if (MAY_HAVE_SYMBOL_GEOMETRY.test(svg)) {
        overrides.removeUnknownsAndDefaults = {
            ...(overrides.removeUnknownsAndDefaults as object | undefined),
            unknownAttrs: false,
        };
    }
    if (!fillBlackForUnfilled) {
        // `removeUnknownsAndDefaults` drops `fill="#000"` (black, #000000, rgb(0,0,0) once
        // `convertColors` has run) as the SVG default; without `fillBlackForUnfilled` the converter
        // would then paint nothing. svgo cannot keep a single default, so keep them all: the other
        // ones match the converter's own defaults.
        overrides.removeUnknownsAndDefaults = {
            ...(overrides.removeUnknownsAndDefaults as object | undefined),
            defaultAttrs: false,
        };
    }
    if (MAY_HAVE_CSS_TRANSFORM.test(svg) || MAY_HAVE_CLIP_SHAPE.test(svg)) {
        overrides.moveElemsAttrsToGroup = false;
        overrides.moveGroupAttrsToElems = false;
        overrides.collapseGroups = false;
        overrides.removeNonInheritableGroupAttrs = false;
        if (overrides.convertPathData !== false)
            overrides.convertPathData = { ...DEFAULT_OVERRIDES.convertPathData, applyTransforms: false };
    }
    if (/<switch\b/.test(svg)) {
        // A <switch> renders one child: merging or dropping its children changes which one.
        overrides.mergePaths = false;
        overrides.removeHiddenElems = false;
    }
    const params: Record<string, unknown> = { overrides };
    if (floatPrecision > SVGO_FLOAT_PRECISION) {
        // The preset hands `floatPrecision` to every plugin that rounds (cleanupNumericValues,
        // convertPathData, convertTransform, convertShapeToPath, mergePaths); the transform
        // precision is a separate parameter, raised so that it stays finer than coordinates.
        const precision = Math.min(floatPrecision, SVGO_MAX_FLOAT_PRECISION);
        const transformPrecision = precision + TRANSFORM_EXTRA_PRECISION;
        params.floatPrecision = precision;
        overrides.convertTransform = { transformPrecision };
        if (overrides.convertPathData !== false)
            overrides.convertPathData = { ...(overrides.convertPathData as object), transformPrecision };
    }
    return { plugins: [{ name: 'preset-default', params }] } as Config;
}

/**
 * Parses (and optionally normalizes) an SVG string into svgo's AST, reusing svgo as the XML
 * parser — no third-party parser needed. The capture plugin grabs the tree in the same pass.
 * `floatPrecision` and `fillBlackForUnfilled` only tune the default svgo config; a caller-supplied
 * `svgoConfig` is used as-is.
 */
export function parseSvg(
    svg: string,
    optimizeFlag: boolean,
    svgoConfig?: Config,
    floatPrecision = SVGO_FLOAT_PRECISION,
    fillBlackForUnfilled = true,
): XastRoot {
    let captured: XastRoot | null = null;
    const capture = {
        name: 'svgvd-capture',
        fn: (root: unknown) => {
            captured = root as XastRoot;
            return {};
        },
    };

    const base = optimizeFlag
        ? (svgoConfig ?? defaultConfigFor(svg, floatPrecision, fillBlackForUnfilled))
        : { plugins: [] };
    const plugins = [...(base.plugins ?? []), capture] as Config['plugins'];

    try {
        optimize(svg, { ...base, plugins });
    } catch (err) {
        throw new Error(`Invalid SVG: ${(err as Error).message}`, { cause: err });
    }
    if (!captured) throw new Error('Failed to parse SVG: empty document');
    return captured;
}
