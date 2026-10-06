import type { Viewport, XastElement } from './gradient.js';
import { presentation } from './style.js';
import { IDENTITY, multiply, type Matrix } from './transform.js';
import { parseLength } from './units.js';

export type { Viewport };

/** Reference length for percentages that are neither horizontal nor vertical (SVG 2, 8.9). */
export const diagonal = (vp: Viewport): number => Math.sqrt((vp.width ** 2 + vp.height ** 2) / 2);

type ViewBox = [minX: number, minY: number, width: number, height: number];

/** Splits a `viewBox` into four numbers, or undefined when absent / malformed (sign not checked). */
function viewBoxNumbers(raw: string | undefined): ViewBox | undefined {
    if (raw === undefined) return undefined;
    const vb = raw
        .trim()
        .split(/[\s,]+/)
        .map(Number);
    return vb.length === 4 && !vb.some(Number.isNaN) ? (vb as ViewBox) : undefined;
}

/** Parses a `viewBox` into [minX, minY, width, height], or undefined when absent / invalid / empty. */
export function parseViewBox(raw: string | undefined): ViewBox | undefined {
    const vb = viewBoxNumbers(raw);
    return vb !== undefined && vb[2] > 0 && vb[3] > 0 ? vb : undefined;
}

/** A parsed `preserveAspectRatio`: alignment keyword (default xMidYMid) and meet/slice. */
interface AspectRatio {
    align: string;
    slice: boolean;
}

function parseAspectRatio(raw = ''): AspectRatio {
    const parts = raw.trim().split(/\s+/);
    return { align: parts[0] || 'xMidYMid', slice: parts[1] === 'slice' };
}

/** Share of the free space placed before the content for a preserveAspectRatio alignment. */
const alignFactor = (align: string, axis: 'x' | 'Y'): number =>
    align.includes(`${axis}Mid`) ? 0.5 : align.includes(`${axis}Max`) ? 1 : 0;

/** Maps a viewBox onto a width×height viewport per preserveAspectRatio (default xMidYMid meet). */
export function viewBoxMatrix(vb: readonly number[], width: number, height: number, par = ''): Matrix {
    const [minX = 0, minY = 0, vbW = width, vbH = height] = vb;
    const { align, slice } = parseAspectRatio(par);
    let sx = width / vbW;
    let sy = height / vbH;
    let tx = 0;
    let ty = 0;
    if (align !== 'none') {
        sx = sy = slice ? Math.max(sx, sy) : Math.min(sx, sy);
        tx = alignFactor(align, 'x') * (width - vbW * sx);
        ty = alignFactor(align, 'Y') * (height - vbH * sy);
    }
    return { a: sx, b: 0, c: 0, d: sy, e: tx - minX * sx, f: ty - minY * sy };
}

/** Root `<svg>` mapped onto the `<vector>`: size in dp, viewport and content offset. */
export interface RootLayout {
    /** `android:width` / `android:height` (dp). */
    width: number;
    height: number;
    /** `android:viewportWidth` / `android:viewportHeight`, grown or shrunk to keep the aspect ratio. */
    viewportWidth: number;
    viewportHeight: number;
    /** Translation bringing the viewBox origin (and the aspect-ratio alignment) into place. */
    offsetX: number;
    offsetY: number;
    /** The viewBox size: the reference for percentage lengths. */
    viewBox: Viewport;
}

/**
 * Lays out the root `<svg>`. A percentage, a font-relative unit (or a missing value) does not
 * define a size, so width/height fall back to the viewBox (then 24).
 */
export function rootLayout(attrs: Record<string, string>): RootLayout {
    const parsed = viewBoxNumbers(attrs.viewBox?.trim() || undefined);
    const hasViewBox = parsed !== undefined;
    const [minX, minY, vpW, vpH] = parsed ?? [0, 0, parseLength(attrs.width) || 24, parseLength(attrs.height) || 24];
    const width = parseLength(attrs.width) || vpW || 24;
    const height = parseLength(attrs.height) || vpH || 24;

    // VectorDrawable stretches its viewport onto width×height; SVG keeps the aspect ratio
    // (preserveAspectRatio, default xMidYMid meet). Grow/shrink the viewport and align the content.
    let viewportWidth = vpW;
    let viewportHeight = vpH;
    let alignX = 0;
    let alignY = 0;
    const { align, slice } = parseAspectRatio(attrs.preserveAspectRatio);
    if (hasViewBox && align !== 'none' && Math.abs(width / height - vpW / vpH) > 1e-9) {
        const s = slice ? Math.max(width / vpW, height / vpH) : Math.min(width / vpW, height / vpH);
        viewportWidth = width / s;
        viewportHeight = height / s;
        alignX = alignFactor(align, 'x') * (viewportWidth - vpW);
        alignY = alignFactor(align, 'Y') * (viewportHeight - vpH);
    }
    return {
        width,
        height,
        viewportWidth,
        viewportHeight,
        offsetX: alignX - minX,
        offsetY: alignY - minY,
        viewBox: { width: vpW, height: vpH },
    };
}

/** Viewport of a nested `<svg>` in its parent's user space. */
export interface NestedLayout {
    x: number;
    y: number;
    width: number;
    height: number;
    /** Maps the nested content into the parent's user space. */
    matrix: Matrix;
    /** Reference for percentage lengths inside the nested `<svg>`. */
    viewport: Viewport;
    clipped: boolean;
}

/**
 * Viewport rectangle of a nested `<svg>` (in its parent's user space), the matrix mapping its
 * content into that space, and whether it clips. Null for an empty viewport (not rendered).
 */
export function nestedLayout(el: XastElement, parentVp: Viewport): NestedLayout | null {
    const { x: xs, y: ys, width: ws, height: hs, viewBox, preserveAspectRatio } = el.attributes ?? {};
    const len = (v: string | undefined, ref: number, fallback: number): number => {
        const parsed = parseLength(v, ref);
        return Number.isNaN(parsed) ? fallback : parsed;
    };
    const x = len(xs, parentVp.width, 0);
    const y = len(ys, parentVp.height, 0);
    const width = len(ws ?? '100%', parentVp.width, parentVp.width);
    const height = len(hs ?? '100%', parentVp.height, parentVp.height);
    if (!(width > 0 && height > 0)) return null;

    const vb = parseViewBox(viewBox);
    const matrix = multiply(
        { ...IDENTITY, e: x, f: y },
        vb ? viewBoxMatrix(vb, width, height, preserveAspectRatio) : IDENTITY,
    );
    const overflow = presentation(el, 'overflow')?.trim();
    return {
        x,
        y,
        width,
        height,
        matrix,
        viewport: vb ? { width: vb[2], height: vb[3] } : { width, height },
        clipped: overflow !== 'visible' && overflow !== 'auto',
    };
}
