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
    convertPathData: { convertToQ: false },
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

function defaultConfigFor(svg: string): Config {
    const overrides: Record<string, unknown> = { ...DEFAULT_OVERRIDES };
    if (exceedsDrawableCount(svg, MERGE_PATHS_MAX_ELEMENTS)) overrides.mergePaths = false;
    if (exceedsPathDataLength(svg, CONVERT_PATH_DATA_MAX_LENGTH)) overrides.convertPathData = false;
    if (MAY_DASH.test(svg)) overrides.convertShapeToPath = { convertArcs: false };
    return { plugins: [{ name: 'preset-default', params: { overrides } }] } as Config;
}

/**
 * Parses (and optionally normalizes) an SVG string into svgo's AST, reusing svgo as the XML
 * parser — no third-party parser needed. The capture plugin grabs the tree in the same pass.
 */
export function parseSvg(svg: string, optimizeFlag: boolean, svgoConfig?: Config): XastRoot {
    let captured: XastRoot | null = null;
    const capture = {
        name: 'svgvd-capture',
        fn: (root: unknown) => {
            captured = root as XastRoot;
            return {};
        },
    };

    const base = optimizeFlag ? (svgoConfig ?? defaultConfigFor(svg)) : { plugins: [] };
    const plugins = [...(base.plugins ?? []), capture] as Config['plugins'];

    try {
        optimize(svg, { ...base, plugins });
    } catch (err) {
        throw new Error(`Invalid SVG: ${(err as Error).message}`, { cause: err });
    }
    if (!captured) throw new Error('Failed to parse SVG: empty document');
    return captured;
}
