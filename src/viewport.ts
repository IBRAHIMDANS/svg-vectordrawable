import type { Viewport, XastElement } from './ast.js';
import { collectByName } from './elements.js';
import {
    closedCssTransform,
    cssComponents,
    isUnresolvableCssLength,
    isValidPropertyValue,
    parseStyle,
    presentation,
    styleDeclarations,
} from './style.js';
import {
    IDENTITY,
    isIdentity,
    multiply,
    parseCssTransform,
    parseTransform,
    parseTransformOrigin,
    type Matrix,
} from './transform.js';
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

/**
 * The root `viewBox` when it disables rendering: four numbers with a zero or negative width or
 * height (SVG 2 §8.6: zero disables rendering, negative is an error). Undefined otherwise, a
 * malformed one included (read as absent).
 */
export function disablingViewBox(attrs: Record<string, string>): string | undefined {
    const raw = attrs.viewBox?.trim() || undefined;
    const vb = viewBoxNumbers(raw);
    return vb !== undefined && !(vb[2] > 0 && vb[3] > 0) ? raw : undefined;
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

/** A declaration the converter cannot resolve: valid CSS, so it overrides the attribute in a browser. */
const UNRESOLVED = 'unresolved';
type Css<T> = T | typeof UNRESOLVED | null;

/** CSS-wide keywords: for these non-inherited properties on the root, the initial value. */
const CSS_WIDE = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
/** Substitution and math functions a browser evaluates and the converter does not. */
const CSS_RUNTIME_FUNCTION = /(?<![\w-])(?:var|env|attr|calc|min|max|clamp|round|mod|rem|abs|sign)\(/i;
/** A nonzero number without unit: invalid in CSS where a length or an angle is expected. */
const BARE_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
export const isBareNonZero = (v: string): boolean => BARE_NUMBER.test(v) && parseFloat(v) !== 0;
/** Keywords of the CSS `width` / `height` that leave the size to the intrinsic one (the attribute). */
const INTRINSIC_SIZE = /^(?:auto|min-content|max-content|fit-content|stretch|-webkit-fill-available|-moz-available)$/i;

/**
 * A CSS `width` / `height` value on the root: its length in px when it defines the size (positive,
 * absolute or `em` / `rem`), `'attribute'` when valid but leaving the size to the attribute (`auto`
 * and the other sizing keywords, the CSS-wide keywords, a percentage of the browser window, zero),
 * `UNRESOLVED` when valid but not resolvable here (`calc()`, `var()`, `ex`, `vw`…: the attribute
 * applies too), null when invalid (a browser drops the declaration: a unitless nonzero number, a
 * negative length, garbage).
 */
function cssSize(value: string): Css<number | 'attribute'> {
    if (CSS_WIDE.has(value.toLowerCase()) || INTRINSIC_SIZE.test(value)) return 'attribute';
    if (CSS_RUNTIME_FUNCTION.test(value) || /^fit-content\(/i.test(value)) return UNRESOLVED;
    if (isBareNonZero(value)) return null;
    const px = parseLength(value);
    if (Number.isFinite(px)) return px > 0 ? px : px === 0 ? 'attribute' : null;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%$/i.test(value)) return parseFloat(value) >= 0 ? 'attribute' : null;
    return isUnresolvableCssLength(value, true) ? UNRESOLVED : null;
}

/**
 * The `width` or `height` of the root `<svg>` in px when it defines the size: the CSS declaration
 * (inline `style`, cascade of {@link cssDeclaration}) when it defines one, else the attribute; NaN
 * when neither does. svgo's `inlineStyles` moves a `<style>` rule (`svg{width:48px}`) there.
 */
function rootSize(attrs: Record<string, string>, name: 'width' | 'height'): number {
    const css = cssDeclaration(attrs.style, name, cssSize)?.read;
    return typeof css === 'number' ? css : positiveLength(attrs[name]);
}

/**
 * Lays out the root `<svg>`. Its `width` / `height` come from the inline `style` first (see {@link
 * rootSize}), then from the attributes. `em` / `rem` count 16 px (`parseLength`); a percentage,
 * `ex` / `ch`, a zero or negative length (or a missing value) does not define a size. With a viewBox, a single
 * defined dimension sets the other through the viewBox aspect ratio, whatever preserveAspectRatio
 * (SVG 2 §8.12 intrinsic sizing, CSS replaced-element sizing); with neither defined, the size is the
 * viewBox's. Without a viewBox, each undefined dimension is 24 (reported through `assumed`). Throws
 * on a viewBox whose width or height is not positive (`disablingViewBox`: convert drops it first).
 */
export function rootLayout(attrs: Record<string, string>): RootLayout {
    const parsed = viewBoxNumbers(attrs.viewBox?.trim() || undefined);
    const hasViewBox = parsed !== undefined;
    // An empty viewBox disables rendering and a negative one is an error (SVG 2, 8.6): either way
    // there is no viewport to emit, and Android rejects a non-positive one.
    if (parsed !== undefined && !(parsed[2] > 0 && parsed[3] > 0))
        throw new Error(`Invalid viewBox "${attrs.viewBox?.trim()}": its width and height must be positive`);
    const attrWidth = rootSize(attrs, 'width');
    const attrHeight = rootSize(attrs, 'height');
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

/**
 * Decimals the root content needs beyond `floatPrecision`: the viewBox → size factor magnifies the
 * viewport units like a group `scale` (`scaledContentPrecision`), so `viewBox="0 0 0.024 0.024"` shown
 * at 24 dp (factor 1000) rounds `0.00123` to `0.001`, 0.3 dp off. `floatPrecision` is meant for
 * viewport units close to a dp: the first decade is absorbed (0 up to a factor of 10, then
 * `ceil(log10(factor / 10))`), which keeps every factor within 10 × half a unit of `floatPrecision`
 * (0.005 dp at 3 decimals) and leaves the output of an icon drawn at up to 10× unchanged.
 */
export function rootExtraDigits(layout: RootLayout): number {
    const factor = Math.max(layout.width / layout.viewportWidth, layout.height / layout.viewportHeight) / 10;
    return factor > 1 && Number.isFinite(factor) ? Math.ceil(Math.log10(factor) - 1e-9) : 0;
}

const translation = (e: number, f: number): Matrix => ({ ...IDENTITY, e, f });

/**
 * A CSS `transform` value on the root: its matrix (`none` and the CSS-wide keywords are the
 * identity), null when invalid (a browser drops the declaration: `translate(5px 5px)`, a unitless
 * nonzero length or angle, garbage; see `isValidPropertyValue`), `UNRESOLVED` when valid but not
 * foldable here (`var()`, `calc()`, a percentage, `ex`, a 3D function…).
 */
function cssTransform(value: string): Css<Matrix> {
    if (CSS_WIDE.has(value.toLowerCase())) return IDENTITY;
    if (!isValidPropertyValue('transform', value)) return null;
    return parseCssTransform(closedCssTransform(value)) ?? UNRESOLVED;
}

/**
 * A CSS `transform-origin` value on the root, on its width×height box (see {@link cssTransform}).
 * Read by its CSS components, as minified by csso (`50%0`, `10%top`) as well as spaced.
 */
function cssOrigin(raw: string, box: Viewport): Css<{ x: number; y: number }> {
    const value = cssComponents(raw).join(' ');
    if (CSS_WIDE.has(value.toLowerCase())) return { x: box.width / 2, y: box.height / 2 };
    if (CSS_RUNTIME_FUNCTION.test(value)) return UNRESOLVED;
    const parts = value.split(/\s+/);
    if (parts.some(isBareNonZero)) return null;
    const o = parseTransformOrigin(value, box);
    if (o) return o;
    return parts.some((p) => isUnresolvableCssLength(p, false)) ? UNRESOLVED : null;
}

/**
 * The declaration of `name` in an inline `style` that applies, read by `read`: an invalid one (null)
 * is skipped, an `!important` one wins over the normal ones, otherwise the last one wins (as
 * `parseStyle`, which does not validate these properties). Undefined when none applies.
 */
function cssDeclaration<T>(
    style: string | undefined,
    name: string,
    read: (value: string) => Css<T>,
): { value: string; read: T | typeof UNRESOLVED } | undefined {
    let out: { value: string; read: T | typeof UNRESOLVED; important: boolean } | undefined;
    for (const [key, value, important] of styleDeclarations(style)) {
        if (key !== name) continue;
        const r = read(value);
        if (r === null || (!important && out?.important)) continue;
        out = { value, read: r, important };
    }
    return out;
}

/**
 * The transform of the root `<svg>`: its CSS `transform` (inline `style`), which overrides the
 * attribute, else the attribute. A CSS one the converter cannot resolve is ignored (reported by
 * {@link layoutWarnings}).
 */
function effectiveRootTransform(attrs: Record<string, string>): Matrix | null {
    const css = cssDeclaration(attrs.style, 'transform', cssTransform)?.read;
    return css === undefined || css === UNRESOLVED ? parseTransform(attrs.transform) : css;
}

/**
 * The `transform-origin` of the root `<svg>`, in px of its width×height box: the CSS one (inline
 * `style`) when resolvable, else the attribute when resolvable, else the initial `50% 50%` (an
 * element with a CSS layout box).
 */
function rootOrigin(attrs: Record<string, string>, { width, height }: RootLayout): { x: number; y: number } {
    const box = { width, height };
    const css = cssDeclaration(attrs.style, 'transform-origin', (v) => cssOrigin(v, box))?.read;
    if (css !== undefined && css !== UNRESOLVED) return css;
    const raw = attrs['transform-origin'];
    return (raw === undefined ? null : parseTransformOrigin(raw, box)) ?? { x: width / 2, y: height / 2 };
}

/**
 * The `transform` of the root `<svg>` (SVG 2), CSS property or attribute, as one matrix in the
 * `<vector>`'s viewport coordinates that also carries the layout offset (viewBox origin,
 * aspect-ratio alignment): the content goes through the offset first. The transform applies to the
 * CSS box of the outermost `<svg>`, i.e. in px of its width×height, around its `transform-origin`
 * (CSS or attribute; initial value `50% 50%` for an element with a CSS layout box: its centre). Null
 * when absent, unparseable or the identity.
 */
export function rootTransform(attrs: Record<string, string>, layout: RootLayout): Matrix | null {
    const t = effectiveRootTransform(attrs);
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
 * drawable, read as if absent), a root CSS `transform` / `transform-origin` that cannot be resolved
 * (`var()`, `calc()`, a percentage of the transform…: ignored) and a root `transform-origin`
 * attribute that cannot be resolved (the transform then turns around the centre). One warning per
 * distinct message. A root CSS `width` / `height` that cannot be resolved (`calc()`, `var()`, `ex`…) is
 * reported too: the attribute applies instead. So is such a root `width` / `height` attribute under a
 * viewBox when no CSS declaration sets the size: a browser resolves it, the converter takes the size
 * from the viewBox.
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
                [attrs[p], `${p}="${attrs[p]}"`],
                [style[p], `style "${p}: ${style[p]}"`],
            ] as const) {
                if (value === undefined || !VIEWPORT_UNIT_RE.test(value)) continue;
                const isStyle = source.startsWith('style');
                // The nested layout reads the attributes only, the root one ignores what it cannot parse.
                const fallback =
                    el === root || isStyle ? 'ignored' : `read as ${p === 'x' || p === 'y' ? '0' : '100%'}`;
                add({
                    code: isStyle ? 'unsupported-style' : 'unsupported-attribute',
                    message: `${source} on ${el === root ? 'the root' : 'a nested'} <svg> uses a viewport-relative unit: it depends on the browser window, undefined for a drawable; ${fallback}.`,
                    node: 'svg',
                });
            }
        }
    }
    const attrs = root.attributes ?? {};
    for (const p of ['width', 'height']) {
        const size = cssDeclaration(attrs.style, p, cssSize);
        // A viewport-relative unit is reported above.
        if (size?.read === UNRESOLVED && !VIEWPORT_UNIT_RE.test(size.value))
            add({
                code: 'unsupported-style',
                message: `style "${p}: ${size.value}" on the root <svg> cannot be resolved; ignored.`,
                node: 'svg',
            });
        // The attribute applies unless the CSS declaration sets the size. Without a viewBox the
        // missing size is reported by convert (`assumed`); a percentage, a zero, `auto` and an
        // invalid value read as absent, as in a browser.
        const raw = attrs[p]?.trim();
        if (
            raw !== undefined &&
            typeof size?.read !== 'number' &&
            parseViewBox(attrs.viewBox) !== undefined &&
            Number.isNaN(positiveLength(raw)) &&
            cssSize(raw) === UNRESOLVED &&
            !VIEWPORT_UNIT_RE.test(raw)
        )
            add({
                code: 'unsupported-attribute',
                message: `${p}="${raw}" on the root <svg> cannot be resolved; ignored, the size follows the viewBox.`,
                node: 'svg',
            });
    }
    const cssT = cssDeclaration(attrs.style, 'transform', cssTransform);
    if (cssT?.read === UNRESOLVED)
        add({
            code: 'unsupported-style',
            message: `style "transform: ${cssT.value}" on the root <svg> is not a 2D transform with absolute units; ignored.`,
            node: 'svg',
        });
    const t = effectiveRootTransform(attrs);
    if (t && !isIdentity(t)) {
        // Whether it resolves does not depend on the box size: any box tells.
        const cssO = cssDeclaration(attrs.style, 'transform-origin', (v) => cssOrigin(v, { width: 1, height: 1 }));
        const origin = attrs['transform-origin'];
        if (cssO?.read === UNRESOLVED)
            add({
                code: 'unsupported-style',
                message: `style "transform-origin: ${cssO.value}" on the root <svg> cannot be resolved; ignored.`,
                node: 'svg',
            });
        if (
            (cssO === undefined || cssO.read === UNRESOLVED) &&
            origin !== undefined &&
            parseTransformOrigin(origin, { width: 1, height: 1 }) === null
        )
            add({
                code: 'unsupported-attribute',
                message: `transform-origin="${origin}" on the root <svg> cannot be resolved; the transform turns around the centre.`,
                node: 'svg',
            });
    }
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
 * The `x` / `y` / `width` / `height` of a nested `<svg>` that are set but cannot be resolved (`ex`,
 * `ch`, garbage…), with the value {@link nestedLayout} uses instead. `auto` (100 %) is resolved.
 */
export function unresolvedNestedLengths(
    el: XastElement,
    parentVp: Viewport,
): { attr: string; value: string; fallback: string }[] {
    const axes = { x: parentVp.width, y: parentVp.height, width: parentVp.width, height: parentVp.height };
    return Object.entries(axes).flatMap(([attr, ref]) => {
        const value = el.attributes?.[attr];
        if (value === undefined || ['', 'auto'].includes(value.trim()) || !Number.isNaN(parseLength(value, ref)))
            return [];
        return [{ attr, value, fallback: attr === 'x' || attr === 'y' ? '0' : '100%' }];
    });
}

/**
 * Viewport rectangle of a nested `<svg>` (in its parent's user space), the matrix mapping its
 * content into that space, and whether it clips. `x` / `y` / `width` / `height` come from the
 * attributes only: the CSS properties do not apply to a nested `<svg>` (svgwg PR 1059; WPT
 * `styling/nested-svg-sizing*.svg`), so browsers ignore them too. Null for an empty viewport (not rendered).
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
