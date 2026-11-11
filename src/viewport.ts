import type { Viewport, XastElement } from './ast.js';
import { collectByName } from './elements.js';
import { parseStyle, presentation } from './style.js';
import { IDENTITY, isIdentity, multiply, parseTransform, parseTransformOrigin, type Matrix } from './transform.js';
import type { Warning } from './types.js';
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
    /**
     * Dimensions the SVG leaves undefined (no viewBox and no usable `width` / `height`), each assumed
     * to be 24. Empty for a sized root.
     */
    assumed: ('width' | 'height')[];
}

/** A length that defines a size: positive and finite, otherwise NaN (falsy, like an unparseable one). */
function positiveLength(raw: string | undefined): number {
    const value = parseLength(raw);
    return value > 0 && Number.isFinite(value) ? value : NaN;
}

/**
 * Lays out the root `<svg>`. `em` / `rem` count 16 px (`parseLength`); a percentage, `ex` / `ch`,
 * a zero or negative length (or a missing value) does not define a size. With a viewBox, a single
 * defined dimension sets the other through the viewBox aspect ratio, whatever preserveAspectRatio
 * (SVG 2 §8.12 intrinsic sizing, CSS replaced-element sizing); with neither defined, the size is the
 * viewBox's. Without a viewBox, each undefined dimension is 24 (reported through `assumed`). Throws
 * on a viewBox whose width or height is not positive.
 */
export function rootLayout(attrs: Record<string, string>): RootLayout {
    const parsed = viewBoxNumbers(attrs.viewBox?.trim() || undefined);
    const hasViewBox = parsed !== undefined;
    // An empty viewBox disables rendering and a negative one is an error (SVG 2, 8.6): either way
    // there is no viewport to emit, and Android rejects a non-positive one.
    if (parsed !== undefined && !(parsed[2] > 0 && parsed[3] > 0))
        throw new Error(`Invalid viewBox "${attrs.viewBox?.trim()}": its width and height must be positive`);
    const attrWidth = positiveLength(attrs.width);
    const attrHeight = positiveLength(attrs.height);
    const [minX, minY, vpW, vpH] = parsed ?? [0, 0, attrWidth || 24, attrHeight || 24];
    // Each dimension: its own length, else the other one through the viewBox ratio, else the
    // viewBox's (or 24). An undefined length or ratio is NaN, so its product is NaN: falsy.
    const ratio = hasViewBox ? vpW / vpH : NaN;
    const width = attrWidth || attrHeight * ratio || vpW;
    const height = attrHeight || attrWidth / ratio || vpH;

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
        assumed: hasViewBox
            ? []
            : (['width', 'height'] as const).filter((d) => !(d === 'width' ? attrWidth : attrHeight)),
    };
}

const translation = (e: number, f: number): Matrix => ({ ...IDENTITY, e, f });

/**
 * The `transform-origin` of the root `<svg>`, in px of its width×height box: the attribute when
 * resolvable, else the initial `50% 50%` (an element with a CSS layout box).
 */
function rootOrigin(attrs: Record<string, string>, { width, height }: RootLayout): { x: number; y: number } {
    const raw = attrs['transform-origin'];
    return (raw === undefined ? null : parseTransformOrigin(raw, { width, height })) ?? { x: width / 2, y: height / 2 };
}

/**
 * The `transform` of the root `<svg>` (SVG 2), as one matrix in the `<vector>`'s viewport
 * coordinates that also carries the layout offset (viewBox origin, aspect-ratio alignment): the
 * content goes through the offset first. The transform applies to the CSS box of the outermost
 * `<svg>`, i.e. in px of its width×height, around its `transform-origin` attribute (initial value
 * `50% 50%` for an element with a CSS layout box: its centre). Null when absent, unparseable or
 * the identity.
 */
export function rootTransform(attrs: Record<string, string>, layout: RootLayout): Matrix | null {
    const t = parseTransform(attrs.transform);
    if (!t || isIdentity(t)) return null;
    const { width, height, viewportWidth, viewportHeight } = layout;
    const o = rootOrigin(attrs, layout);
    const around = multiply(translation(o.x, o.y), multiply(t, translation(-o.x, -o.y)));
    // viewport units → px → transformed px → viewport units.
    const toPx: Matrix = { ...IDENTITY, a: width / viewportWidth, d: height / viewportHeight };
    const fromPx: Matrix = { ...IDENTITY, a: viewportWidth / width, d: viewportHeight / height };
    return multiply(fromPx, multiply(around, multiply(toPx, translation(layout.offsetX, layout.offsetY))));
}

/**
 * A viewport-relative length (CSS Values 4 §6.1.2: `vw`, `vh`, `vmin`, `svh`, `dvmax`…, and the
 * container units that fall back to them), also inside `calc()`.
 */
const VIEWPORT_UNIT_RE = /\d(?:[sld]?v|cq)(?:w|h|i|b|min|max)\b/i;

/**
 * Warnings for what the layout of the `<svg>` elements reads but cannot honour: viewport-relative
 * units on the root (`width` / `height`) or a nested `<svg>` (`x` / `y` / `width` / `height`),
 * attribute or style declaration, whose size depends on the browser window (undefined for a
 * drawable: ignored on the root, read as `0` / `100%` on a nested one, whose style declaration
 * overrides the attribute), and a root `transform-origin` attribute that cannot be resolved
 * (the transform then turns around the centre). One warning per distinct message.
 */
export function layoutWarnings(root: XastElement): Warning[] {
    const out = new Map<string, Warning>();
    const add = (w: Warning): void => void out.set(w.message, w);
    const nested: XastElement[] = [];
    collectByName(root, new Set(['svg']), nested);
    for (const el of [root, ...nested]) {
        const props = el === root ? ['width', 'height'] : ['x', 'y', 'width', 'height'];
        const attrs = el.attributes ?? {};
        const style = parseStyle(attrs.style);
        for (const p of props) {
            for (const [value, source] of [
                // A nested layout reads the style declaration over the attribute: then the attribute is moot.
                [el !== root && style[p] !== undefined ? undefined : attrs[p], `${p}="${attrs[p]}"`],
                [style[p], `style "${p}: ${style[p]}"`],
            ] as const) {
                if (value === undefined || !VIEWPORT_UNIT_RE.test(value)) continue;
                const isStyle = source.startsWith('style');
                // The nested layout reads an unresolvable length as 0 / 100%, the root one ignores it.
                const fallback = el === root ? 'ignored' : `read as ${p === 'x' || p === 'y' ? '0' : '100%'}`;
                add({
                    code: isStyle ? 'unsupported-style' : 'unsupported-attribute',
                    message: `${source} on ${el === root ? 'the root' : 'a nested'} <svg> uses a viewport-relative unit: it depends on the browser window, undefined for a drawable; ${fallback}.`,
                    node: 'svg',
                });
            }
        }
    }
    const { transform, 'transform-origin': origin } = root.attributes ?? {};
    const t = parseTransform(transform);
    // Whether it resolves does not depend on the box size: any box tells.
    if (origin !== undefined && t && !isIdentity(t) && parseTransformOrigin(origin, { width: 1, height: 1 }) === null)
        add({
            code: 'unsupported-attribute',
            message: `transform-origin="${origin}" on the root <svg> cannot be resolved; the transform turns around the centre.`,
            node: 'svg',
        });
    return [...out.values()];
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
 * `x` / `y` / `width` / `height` are geometry properties (SVG 2 §8.8): a `style` declaration
 * overrides the attribute, as in browsers. An unresolvable value (`auto`, `5vw`…) reads as
 * `0` / `100%`.
 */
export function nestedLayout(el: XastElement, parentVp: Viewport): NestedLayout | null {
    const { viewBox, preserveAspectRatio } = el.attributes ?? {};
    const len = (name: string, ref: number, fallback: number): number => {
        const parsed = parseLength(presentation(el, name), ref);
        return Number.isNaN(parsed) ? fallback : parsed;
    };
    const x = len('x', parentVp.width, 0);
    const y = len('y', parentVp.height, 0);
    const width = len('width', parentVp.width, parentVp.width);
    const height = len('height', parentVp.height, parentVp.height);
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
