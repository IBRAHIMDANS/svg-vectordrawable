import { Resvg } from '@resvg/resvg-js';

/**
 * Pixel comparison of two SVG renderings (resvg, transparent background, same output width).
 *
 * Metric: a pixel *mismatches* when the largest per-channel difference of its premultiplied RGBA
 * values exceeds {@link DEFAULT_CHANNEL_TOLERANCE}. Premultiplied channels (what resvg returns) make
 * colour differences under near-zero alpha irrelevant, as they are invisible.
 * The mismatch ratio is `mismatching pixels / inked pixels`, where inked = non-transparent in either
 * image. Normalizing by ink instead of the canvas area keeps the ratio independent of how much empty
 * space an icon has, so dropping a small detail of a sparse icon still registers.
 */

/** Output width of every render. 256 px ≈ an xxxhdpi 64dp icon: big enough to show 1-unit details of a 24-unit viewport. */
export const RENDER_WIDTH = 256;

/**
 * Max per-channel delta (0–255, premultiplied) still considered equal: 64 ≈ 25 % coverage.
 * Absorbs antialiasing noise from re-encoded geometry (coordinates rounded to 3 decimals, arcs
 * re-expressed, shapes turned into paths, svgo merging strokes into one path) — the fixtures measure
 * a max delta of 0–41 — while a real colour / shape error moves whole regions by far more.
 */
export const DEFAULT_CHANNEL_TOLERANCE = 64;

/**
 * Max mismatch ratio (of inked pixels) for a conversion to count as visually identical: 1 %.
 * Faithful conversions measure 0 % on the fixtures and ≤ 0.2 % on the icon corpora (antialiasing at
 * stroke junctions once svgo merges separate paths); a dropped, shifted or recoloured shape in the
 * deliberately broken cases of test/visual.test.ts measures ≫ 5 %.
 */
export const DEFAULT_MAX_MISMATCH = 0.01;

/** A rasterized SVG: premultiplied RGBA, row-major. */
export interface Raster {
    width: number;
    height: number;
    pixels: Uint8Array;
}

export interface CompareResult {
    /** Mismatching pixels / inked pixels (0 when nothing is inked in either image). 1 when sizes differ. */
    mismatch: number;
    /** Number of mismatching pixels. */
    mismatched: number;
    /** Pixels non-transparent in either image. */
    inked: number;
    /** Largest per-channel delta seen (0–255). */
    maxDelta: number;
    /** `null` when sizes match, otherwise a description of the size mismatch. */
    sizeMismatch: string | null;
}

/** Renders an SVG string at {@link RENDER_WIDTH} px wide (height follows the aspect ratio). */
export function renderSvg(svg: string, width = RENDER_WIDTH): Raster {
    const resvg = new Resvg(svg, {
        fitTo: { mode: 'width', value: width },
        font: { loadSystemFonts: false },
    });
    const image = resvg.render();
    return { width: image.width, height: image.height, pixels: new Uint8Array(image.pixels) };
}

/** Compares two rasters pixel by pixel (see the module doc for the metric). */
export function compareRasters(a: Raster, b: Raster, tolerance = DEFAULT_CHANNEL_TOLERANCE): CompareResult {
    if (a.width !== b.width || a.height !== b.height) {
        return {
            mismatch: 1,
            mismatched: 0,
            inked: 0,
            maxDelta: 255,
            sizeMismatch: `${a.width}×${a.height} vs ${b.width}×${b.height}`,
        };
    }
    let mismatched = 0;
    let inked = 0;
    let maxDelta = 0;
    const pa = a.pixels;
    const pb = b.pixels;
    for (let i = 0; i < pa.length; i += 4) {
        if (pa[i + 3] === 0 && pb[i + 3] === 0) continue;
        inked++;
        let delta = 0;
        for (let c = 0; c < 4; c++) delta = Math.max(delta, Math.abs(pa[i + c]! - pb[i + c]!));
        if (delta > maxDelta) maxDelta = delta;
        if (delta > tolerance) mismatched++;
    }
    return { mismatch: inked ? mismatched / inked : 0, mismatched, inked, maxDelta, sizeMismatch: null };
}

/** Renders both SVGs at the same width and compares them. */
export function compareSvgs(expected: string, actual: string, tolerance = DEFAULT_CHANNEL_TOLERANCE): CompareResult {
    return compareRasters(renderSvg(expected), renderSvg(actual), tolerance);
}
