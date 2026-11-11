import { toAndroidColor } from './color.js';
import { collectByName, foreignElements, GROUPS, isNotRendered, pathDataOf } from './elements.js';
import { escapeXml, formatNumber } from './format.js';
import type { XastElement } from './ast.js';
import { initialStyle, isHidden, resolveStyle, strokeWidthOf, type Inherited } from './inherited.js';
import {
    evenOddToNonZero,
    normalizeArcFlags,
    pathBBox,
    reversePathData,
    transformPathData,
    windingSign,
} from './pathData.js';
import { shapeToPathData, SHAPE_NAMES } from './shapes.js';
import { isNone, presentation } from './style.js';
import { IDENTITY, multiply, parseTransform, type Matrix } from './transform.js';
import type { Warning } from './types.js';
import { parseLength } from './units.js';
import type { Viewport } from './viewport.js';

type Box = { x: number; y: number; width: number; height: number };

/** A mask resolved for one element: the clips that reproduce it (outermost first), or why it is not one. */
export type MaskClip = { clipIds: string[] } | { reason: string };

/** Mask content flattened into clip pieces; `strokeIgnored` when a stroke of the content was left out. */
interface MaskPieces {
    pieces: string[];
    strokeIgnored: boolean;
}

/** A mask's content as a registered clip, or why it is not clip-equivalent. */
type MaskContent = { clipId: string; box: Box; strokeIgnored: boolean } | { reason: string };

/** A `<mask>` element and the style its content inherits (from the mask's own ancestors). */
interface MaskDef {
    el: XastElement;
    style: Inherited;
}

const URL_REF = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/;

/** `clip-path` values that clip nothing: `none` and the CSS-wide keywords resolving to it (not inherited). */
const NO_CLIP = new Set(['none', 'initial', 'unset', 'revert', 'revert-layer']);

/** Why a `clip-path` value other than `none`, `url(#id)` or a basic shape is not converted. */
function unsupportedClipReason(value: string): string {
    if (/^url\(/i.test(value)) return 'references an external resource, which is not resolved';
    if (GEOMETRY_BOX.test(value)) return 'is a reference box without a basic shape, which is not converted';
    return 'is not a url(#id) reference nor a basic shape';
}

/** A `<geometry-box>` keyword on its own. */
const GEOMETRY_BOX = /^(?:content|padding|border|margin|fill|stroke|view)-box$/i;

/** `[<geometry-box>] <basic-shape>() [<geometry-box>]`: the box on either side, at most once. */
const BASIC_SHAPE = /^(?:([a-z-]+)\s+)?([a-z-]+)\(([^()]*)\)(?:\s+([a-z-]+))?$/i;

/**
 * Reference box of a basic shape on an SVG element (CSS Masking 1 §5.1, `clip-path`): "If no
 * reference box is specified, the border-box will be used as reference box", and "For SVG elements
 * without associated CSS layout box, the used value for content-box and padding-box is fill-box and
 * for border-box and margin-box is stroke-box" (asserted by wpt
 * css/css-masking/clip-path-svg-content/clip-path-inset-stroke-001.svg / -002.svg).
 */
const REFERENCE_BOX: Record<string, 'fill-box' | 'stroke-box' | 'view-box'> = {
    'content-box': 'fill-box',
    'padding-box': 'fill-box',
    'fill-box': 'fill-box',
    'border-box': 'stroke-box',
    'margin-box': 'stroke-box',
    'stroke-box': 'stroke-box',
    'view-box': 'view-box',
};

/** A basic shape resolved in its reference box: pathData under `rule`, or why it is not converted. */
type ShapeGeometry = { d: string; rule: ClipRule } | { reason: string };

/** Fractions of the box of the `<position>` keywords, per axis. */
const POSITION_X: Record<string, number> = { left: 0, center: 0.5, right: 1 };
const POSITION_Y: Record<string, number> = { top: 0, center: 0.5, bottom: 1 };

const isVertical = (t: string): boolean => t === 'top' || t === 'bottom';
const isHorizontal = (t: string): boolean => t === 'left' || t === 'right';

/**
 * A `<position>` of one or two values (keywords or `<length-percentage>`) in `box`, `center` when
 * absent; null for the 3- and 4-value forms (edge offsets) and anything invalid.
 */
function positionIn(tokens: readonly string[], box: Box): { x: number; y: number } | null {
    let h = 'center';
    let v = 'center';
    if (tokens.length === 1) {
        if (isVertical(tokens[0]!)) v = tokens[0]!;
        else h = tokens[0]!;
    } else if (tokens.length === 2) {
        [h, v] = tokens as [string, string];
        // A keyword pair may come vertical first (`top left`); a pair with a length may not.
        if (isVertical(h) || isHorizontal(v)) {
            if (!(Object.hasOwn(POSITION_Y, h) && Object.hasOwn(POSITION_X, v))) return null;
            [h, v] = [v, h];
        }
        if (isVertical(h) || isHorizontal(v)) return null;
    } else if (tokens.length) return null;
    const coord = (t: string, keywords: Record<string, number>, origin: number, size: number): number =>
        origin + (Object.hasOwn(keywords, t) ? keywords[t]! * size : parseLength(t, size));
    const x = coord(h, POSITION_X, box.x, box.width);
    const y = coord(v, POSITION_Y, box.y, box.height);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Splits `[<radii>] [at <position>]`; null when `at` has no position. */
function splitAt(tokens: readonly string[]): { radii: string[]; at: string[] } | null {
    const i = tokens.indexOf('at');
    if (i < 0) return { radii: [...tokens], at: [] };
    const at = tokens.slice(i + 1);
    return at.length ? { radii: tokens.slice(0, i), at } : null;
}

/**
 * A `<shape-radius>`: `closest-side` (the default) / `farthest-side` pick among the distances from
 * the center to the box sides; a `<length-percentage>` (`%` of `ref`) must not be negative.
 */
function radiusOf(token: string | undefined, distances: readonly number[], ref: number): number {
    if (token === undefined || token === 'closest-side') return Math.min(...distances);
    if (token === 'farthest-side') return Math.max(...distances);
    const r = parseLength(token, ref);
    return r >= 0 ? r : NaN;
}

/** One CSS token of a basic shape's arguments: a dimension / percentage / number, an identifier, a comma. */
const CSS_TOKEN = /\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:%|[a-z]+)?|[a-z-]+|,)\s*/y;

/**
 * The tokens of `args`, null when something else appears. Tokens need no whitespace between them
 * when CSS does not (svgo's minifier writes `100%0` for `100% 0`).
 */
function cssTokens(args: string): string[] | null {
    const out: string[] = [];
    let pos = 0;
    while (pos < args.length) {
        CSS_TOKEN.lastIndex = pos;
        const m = CSS_TOKEN.exec(args);
        if (!m) return args.slice(pos).trim() ? null : out;
        out.push(m[1]!);
        pos = CSS_TOKEN.lastIndex;
    }
    return out;
}

const INVALID: ShapeGeometry = { reason: 'is not a valid basic shape (or uses a form that is not converted)' };
const EMPTY: ShapeGeometry = { reason: 'is an empty shape' };

/**
 * Resolves a CSS basic shape (CSS Shapes 1 §3.1) in `box` (lower-case `fn` / `args`) into pathData
 * in the box's user space:
 * - `inset(<length-percentage>{1,4})`, percentages of the box height (top / bottom) or width
 *   (left / right);
 * - `circle([<shape-radius>] [at <position>])`, a percentage radius of √(w² + h²)/√2;
 * - `ellipse([<shape-radius>{2}] [at <position>])`, percentages of the width / height;
 * - `polygon([nonzero | evenodd,] [<length-percentage> <length-percentage>]#)`, relative to the
 *   box origin.
 * Not converted (reason returned): `inset(… round …)`, `path()`, `rect()`, `xywh()`, the 3- and
 * 4-value `<position>`, `closest-corner` / `farthest-corner`, and an empty shape (it would clip
 * everything; a VectorDrawable clip needs geometry).
 */
function basicShape(fn: string, args: string, box: Box, precision: number): ShapeGeometry {
    const r = (v: number): string => formatNumber(v, precision);
    const all = cssTokens(args);
    if (!all) return INVALID;
    const tokens = all.filter((t) => t !== ',');
    if (fn !== 'polygon' && tokens.length !== all.length) return INVALID;
    const { x, y, width: w, height: h } = box;
    switch (fn) {
        case 'inset': {
            if (tokens.includes('round')) return { reason: 'uses rounded corners (round), which are not converted' };
            if (tokens.length < 1 || tokens.length > 4) return INVALID;
            const [t, rt = t, b = t, l = rt] = tokens as [string, ...string[]];
            const [top, right, bottom, left] = [
                parseLength(t, h),
                parseLength(rt!, w),
                parseLength(b!, h),
                parseLength(l!, w),
            ];
            if (![top, right, bottom, left].every(Number.isFinite)) return INVALID;
            // Insets adding up to more than a dimension are reduced proportionally (CSS Shapes 1): empty.
            const width = w - left - right;
            const height = h - top - bottom;
            if (width <= 0 || height <= 0) return EMPTY;
            return { d: `M${r(x + left)},${r(y + top)}h${r(width)}v${r(height)}h${r(-width)}z`, rule: 'nonzero' };
        }
        case 'circle':
        case 'ellipse': {
            const parts = splitAt(tokens);
            const count = fn === 'circle' ? 1 : 2;
            if (!parts || (parts.radii.length !== 0 && parts.radii.length !== count)) return INVALID;
            const c = positionIn(parts.at, box);
            if (!c) return INVALID;
            const dx = [Math.abs(c.x - x), Math.abs(x + w - c.x)];
            const dy = [Math.abs(c.y - y), Math.abs(y + h - c.y)];
            const rx =
                fn === 'circle'
                    ? radiusOf(parts.radii[0], [...dx, ...dy], Math.sqrt((w * w + h * h) / 2))
                    : radiusOf(parts.radii[0], dx, w);
            const ry = fn === 'circle' ? rx : radiusOf(parts.radii[1], dy, h);
            if (!Number.isFinite(rx) || !Number.isFinite(ry)) return INVALID;
            const d =
                rx > 0 && ry > 0
                    ? shapeToPathData('ellipse', { cx: r(c.x), cy: r(c.y), rx: r(rx), ry: r(ry) }, { precision })
                    : null;
            return d ? { d, rule: 'nonzero' } : EMPTY;
        }
        case 'polygon': {
            const items: string[][] = [[]];
            for (const t of all) {
                if (t === ',') items.push([]);
                else items.at(-1)!.push(t);
            }
            let rule: ClipRule = 'nonzero';
            const first = items[0]!;
            if (first.length === 1 && (first[0] === 'nonzero' || first[0] === 'evenodd')) {
                rule = first[0];
                items.shift();
            }
            const points: string[] = [];
            for (const xy of items) {
                if (xy.length !== 2) return INVALID;
                const px = x + parseLength(xy[0], w);
                const py = y + parseLength(xy[1], h);
                if (!Number.isFinite(px) || !Number.isFinite(py)) return INVALID;
                points.push(`${r(px)},${r(py)}`);
            }
            return points.length < 3 ? EMPTY : { d: `M${points.join('L')}z`, rule };
        }
        default:
            return { reason: 'is a basic shape that is not converted' };
    }
}

/**
 * Root `color` seen by mask content. The `currentColor` option is not known here: an unparseable
 * color makes `currentColor` (unless a `color` is set in the tree) refuse the mask rather than guess.
 */
const UNKNOWN_COLOR = 'none';

const EPSILON = 1e-6;

const contains = (outer: Box, inner: Box): boolean =>
    inner.x >= outer.x - EPSILON &&
    inner.y >= outer.y - EPSILON &&
    inner.x + inner.width <= outer.x + outer.width + EPSILON &&
    inner.y + inner.height <= outer.y + outer.height + EPSILON;

/** Bounding box of several path pieces (each measured alone: a piece may start with a relative `m`). */
function unionBBox(pieces: readonly string[]): Box | null {
    let box: Box | null = null;
    for (const d of pieces) {
        const b = pathBBox(d);
        if (!b) continue;
        if (!box) box = b;
        else {
            const x = Math.min(box.x, b.x);
            const y = Math.min(box.y, b.y);
            box = {
                x,
                y,
                width: Math.max(box.x + box.width, b.x + b.width) - x,
                height: Math.max(box.y + box.height, b.y + b.height) - y,
            };
        }
    }
    return box;
}

/** An element's transform composed after the accumulated matrix `m` (null when both are absent). */
function childMatrix(el: XastElement, m: Matrix | null): Matrix | null {
    const own = parseTransform(el.attributes?.transform);
    return own ? multiply(m ?? IDENTITY, own) : m;
}

/** A mask region coordinate: a fraction or percentage of the bbox (objectBoundingBox units). */
function fraction(v: string): number {
    const s = v.trim();
    return s.endsWith('%') ? parseFloat(s) / 100 : Number(s);
}

/** Renders a `<clip-path>` element at `indent`. */
export const clipPathElement = (d: string, indent: string): string =>
    `${indent}<clip-path android:pathData="${escapeXml(normalizeArcFlags(d))}" />`;

/** Wraps already-rendered content in a `<group>` clipped by `d`. */
export const wrapClip = (d: string, body: string, pad: string, step: string): string =>
    `${pad}<group>\n${clipPathElement(d, pad + step)}\n${body.replace(/^/gm, step)}\n${pad}</group>`;

/**
 * The document's `<clipPath>` elements, resolved on demand into one pathData each (cached, so a
 * clip shared by several elements is reported once). Also hosts the synthetic viewport clips of
 * nested `<svg>` elements.
 */
export class ClipPaths {
    private readonly byId = new Map<string, XastElement>();
    private readonly cache = new Map<string, string | null>();
    private readonly masks = new Map<string, MaskDef>();
    /** Mask content resolved once per mask (userSpaceOnUse content does not depend on the element). */
    private readonly maskContents = new Map<string, MaskContent>();
    /** Masks already reported as `mask-approximated` (once per mask, whatever the units). */
    private readonly approximatedMasks = new Set<string>();
    private syntheticCount = 0;
    /** Elements outside the SVG namespace: skipped by every walk, like the renderer (`isNotRendered`). */
    private readonly foreign: WeakSet<XastElement>;

    constructor(
        svgEl: XastElement,
        private readonly warn: (w: Warning) => void,
        /** Percentages inside a clipPath resolve against the root viewport. */
        private readonly viewport: Viewport,
        private readonly precision: number,
    ) {
        this.foreign = foreignElements(svgEl);
        const clipEls: XastElement[] = [];
        collectByName(svgEl, new Set(['clipPath']), clipEls);
        for (const clip of clipEls) {
            const id = clip.attributes?.id;
            if (id && !this.byId.has(id)) this.byId.set(id, clip);
        }
        this.collectMasks(svgEl, [svgEl]);
    }

    /**
     * Resolves the `clip-path` of `el` (a group or drawable leaf whose computed style is `style`)
     * into pathData in its user space (after its own transform); null when absent or unusable. Read
     * like any presentation property (inline `style` first, where svgo inlines `<style>` rules, then
     * the attribute); never inherited, so only the element's own attributes count. `url(#id)` and the
     * CSS basic shapes (see `resolveShape`) are converted; anything else (a reference box alone, an
     * external url…) is reported as `unsupported-clip-path`.
     */
    resolve(el: XastElement, style: Inherited): string | null {
        const value = (presentation(el, 'clip-path') ?? '').trim();
        if (!value || NO_CLIP.has(value.toLowerCase())) return null;
        const shape = BASIC_SHAPE.exec(value);
        if (shape && shape[2]!.toLowerCase() !== 'url') return this.resolveShape(el, style, value, shape);
        const m = URL_REF.exec(value);
        if (!m) {
            this.warnClip(value, unsupportedClipReason(value));
            return null;
        }
        const id = m[1]!;
        const clip = this.byId.get(id);
        if (!clip) {
            this.warn({ code: 'missing-clip-path', message: `Unknown clip-path "${id}"; ignored.`, node: 'clip-path' });
            return null;
        }
        if (!this.cache.has(id)) this.cache.set(id, this.geometryOf(id, clip));
        return this.cache.get(id)!;
    }

    /** Reports a `clip-path` value that is not converted. */
    private warnClip(value: string, reason: string): void {
        this.warn({
            code: 'unsupported-clip-path',
            message: `clip-path "${value}" ${reason}; ignored.`,
            node: 'clip-path',
        });
    }

    /**
     * A CSS basic shape (`[<geometry-box>] <basic-shape> [<geometry-box>]`, see `basicShape`) laid
     * out in the reference box of `el` (see `REFERENCE_BOX`): its fill-box is its geometric bounding
     * box (`elementBBox`, like objectBoundingBox units). The stroke-box (the default) is the same box
     * when no stroke is painted (on the element or, for a group, its content); a painted stroke, which
     * makes the stroke bounding box larger (joins, caps), and the view-box are not converted.
     */
    private resolveShape(el: XastElement, style: Inherited, value: string, match: RegExpExecArray): string | null {
        const shape = this.shapeGeometry(el, style, match);
        if ('reason' in shape) {
            this.warnClip(value, shape.reason);
            return null;
        }
        return this.toNonZero(shape.d, shape.rule, 'clip-path', 'fill-rule="evenodd" in polygon()');
    }

    private shapeGeometry(el: XastElement, style: Inherited, match: RegExpExecArray): ShapeGeometry {
        const [, before, fn, args, after] = match;
        if (before && after) return INVALID;
        const boxName = (before ?? after ?? 'border-box').toLowerCase();
        const reference = Object.hasOwn(REFERENCE_BOX, boxName) ? REFERENCE_BOX[boxName] : undefined;
        if (!reference) return INVALID;
        if (reference === 'view-box') return { reason: 'uses the view-box reference box, which is not converted' };
        if (reference === 'stroke-box' && this.paintsStroke(el, style)) {
            const which = before || after ? boxName : 'border-box, the default';
            return {
                reason: `lays out in the stroke bounding box (${which}) of a stroked element, which is not converted`,
            };
        }
        const box = this.elementBBox(el, style.viewport);
        if (!box) return { reason: 'needs the bounding box of the element, which is unknown' };
        return basicShape(fn!.toLowerCase(), args!.toLowerCase(), box, this.precision);
    }

    /** True when `el` (or, for a group, any of its rendered content) paints a stroke. */
    private paintsStroke(el: XastElement, style: Inherited): boolean {
        if (!GROUPS.has(el.name ?? '')) return !isNone(style.stroke) && strokeWidthOf(style) > 0;
        return (el.children ?? []).some(
            (c) =>
                c.type === 'element' && !isNotRendered(c, this.foreign) && this.paintsStroke(c, resolveStyle(c, style)),
        );
    }

    /**
     * `d` under `rule` as a nonzero path (a VectorDrawable `<clip-path>` is always nonzero): an evenodd
     * path is rewritten by orienting its contours by nesting depth, with the same outer orientation for
     * every piece, so pieces add up (union) instead of cancelling. Contours that cross or touch have no
     * such rewrite: reported, and nonzero is used.
     */
    private toNonZero(d: string, rule: ClipRule, node: string, what: string): string {
        if (rule !== 'evenodd') return d;
        const nonzero = evenOddToNonZero(d, 1);
        if (nonzero === null)
            this.warn({
                code: 'unsupported-clip-path',
                message: `${what} with crossing or touching contours has no nonzero equivalent in a VectorDrawable <clip-path>; nonzero is used.`,
                node,
            });
        return nonzero ?? d;
    }

    /** Registers a rectangular clip (a nested `<svg>` viewport) and returns its unique id. */
    addViewportClip(x: number, y: number, width: number, height: number): string {
        const id = this.uniqueId('svgvd-viewport');
        const rect = { x: String(x), y: String(y), width: String(width), height: String(height) };
        this.byId.set(id, {
            type: 'element',
            name: 'clipPath',
            attributes: { id },
            children: [{ type: 'element', name: 'rect', attributes: rect }],
        });
        return id;
    }

    /** An id no `<clipPath>` (nor synthetic clip) uses yet. */
    private uniqueId(prefix: string): string {
        let id: string;
        do id = `${prefix}-${++this.syntheticCount}`;
        while (this.byId.has(id));
        return id;
    }

    /** Registers a clip whose geometry is already resolved and returns its unique id. */
    private addResolvedClip(prefix: string, d: string): string {
        const id = this.uniqueId(prefix);
        this.byId.set(id, { type: 'element', name: 'clipPath', attributes: { id }, children: [] });
        this.cache.set(id, d);
        return id;
    }

    /** Indexes the `<mask>` elements with the style their content inherits from the mask's ancestors. */
    private collectMasks(node: XastElement, ancestors: XastElement[]): void {
        for (const c of node.children ?? []) {
            if (c.type !== 'element') continue;
            const id = c.attributes?.id;
            if (c.name === 'mask' && id && !this.masks.has(id)) {
                let style = initialStyle(UNKNOWN_COLOR, this.viewport);
                for (const a of ancestors) style = resolveStyle(a, style);
                // Opacity is not inherited: only the mask's own (and its content's) counts.
                this.masks.set(id, { el: c, style: resolveStyle(c, { ...style, opacityMul: 1 }) });
            }
            this.collectMasks(c, [...ancestors, c]);
        }
    }

    /**
     * Resolves the `mask` of `el` (a group or drawable leaf) into clips, when the mask is
     * *clip-equivalent*: its mask value is exactly 1 inside some shapes and 0 elsewhere, which is
     * what a VectorDrawable `<clip-path>` (nonzero rule) draws. That holds when:
     * - `mask-type` is `luminance` (default) and every painting shape is opaque white (luminance 1,
     *   alpha 1), or `mask-type` is `alpha` and every painting shape is opaque (any color);
     * - "opaque" covers the fill color alpha, `fill-opacity` and `opacity` (own and inherited
     *   inside the mask; ancestors of the `<mask>` only pass inherited properties down);
     * - no shape paints a gradient / pattern fill, or carries a `filter` / `mask` / `clip-path`;
     *   only groups, paths and basic shapes (`<use>` is already inlined as groups) appear. Shapes that
     *   paint nothing (fill and stroke `none`, `display: none`, hidden, empty geometry) are ignored;
     * - strokes are the one approximation: a clip-path has no stroke outline, so the stroke of the
     *   content is ignored (`mask-approximated`, once per mask) and a stroke-only shape is dropped;
     *   content left empty that way refuses the mask;
     * - a `fill-rule="evenodd"` shape is rewritten into the same region under nonzero (a clip-path is
     *   nonzero), which fails only when its contours cross or touch;
     * - `maskContentUnits` is `userSpaceOnUse` (default: the element's user space) or
     *   `objectBoundingBox` (content mapped onto the element's bbox);
     * - the mask region (`x`/`y`/`width`/`height`, `maskUnits` defaulting to objectBoundingBox
     *   -10 % / -10 % / 120 % / 120 %) also clips: when it cuts the content, a second
     *   rectangular clip is returned (nested Android clips intersect).
     * The clips live in the element's user space (after its own transform), like its clip-path.
     */
    resolveMask(el: XastElement, viewport: Viewport): MaskClip {
        const ref = URL_REF.exec((presentation(el, 'mask') ?? '').trim());
        if (!ref) return { reason: 'not a url(#id) reference' };
        const id = ref[1]!;
        const mask = this.masks.get(id);
        if (!mask) return { reason: `unknown mask "${id}"` };
        const attrs = mask.el.attributes ?? {};
        const type = (presentation(mask.el, 'mask-type') ?? 'luminance').trim();
        if (type !== 'luminance' && type !== 'alpha') return { reason: `mask-type="${type}"` };

        const boxUnits = attrs.maskUnits !== 'userSpaceOnUse';
        const boxContent = attrs.maskContentUnits === 'objectBoundingBox';
        let bbox: Box | null = null;
        if (boxUnits || boxContent) {
            bbox = this.elementBBox(el, viewport);
            if (!bbox || bbox.width <= 0 || bbox.height <= 0)
                return { reason: 'its objectBoundingBox units need a non-empty bounding box' };
        }

        let content = boxContent ? undefined : this.maskContents.get(id);
        if (!content) {
            const m = boxContent ? { a: bbox!.width, b: 0, c: 0, d: bbox!.height, e: bbox!.x, f: bbox!.y } : null;
            content = this.maskContent(mask, m);
            if (!boxContent) this.maskContents.set(id, content);
        }
        if ('reason' in content) return content;

        const region = this.maskRegion(attrs, boxUnits ? bbox : null, viewport);
        if (!region) return { reason: 'its region (x/y/width/height) cannot be resolved' };
        const inside = contains(region, content.box);
        const { x, y, width, height } = region;
        if (!inside && (width <= 0 || height <= 0)) return { reason: 'its region is empty' };
        if (content.strokeIgnored) this.reportApproximatedMask(id);
        if (inside) return { clipIds: [content.clipId] };
        const rect = `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
        return { clipIds: [content.clipId, this.addResolvedClip('svgvd-mask-region', rect)] };
    }

    /** Warns once per mask that the stroke of its content was ignored. */
    private reportApproximatedMask(id: string): void {
        if (this.approximatedMasks.has(id)) return;
        this.approximatedMasks.add(id);
        this.warn({
            code: 'mask-approximated',
            message: `mask "${id}": the stroke of its content is ignored (a clip-path draws no stroke); the masked area differs along the stroked outlines.`,
            node: 'mask',
        });
    }

    /** The mask content as a registered clip, or why it is not clip-equivalent. */
    private maskContent(mask: MaskDef, m: Matrix | null): MaskContent {
        const alpha = (presentation(mask.el, 'mask-type') ?? '').trim() === 'alpha';
        const acc: MaskPieces = { pieces: [], strokeIgnored: false };
        const reason = this.flattenMask(mask.el, mask.style, m, alpha, acc);
        if (reason) return { reason };
        const box = unionBBox(acc.pieces);
        if (!box)
            return {
                reason: acc.strokeIgnored
                    ? 'its content only paints strokes, which a clip-path cannot draw'
                    : 'its content is empty (the element is hidden)',
            };
        return { clipId: this.addResolvedClip('svgvd-mask', unite(acc.pieces)), box, strokeIgnored: acc.strokeIgnored };
    }

    /**
     * Flattens clip-equivalent mask content into absolute pathData pieces; returns a reason otherwise.
     * Strokes are left out (flagged in `acc.strokeIgnored`): only fills become pieces.
     */
    private flattenMask(
        node: XastElement,
        style: Inherited,
        m: Matrix | null,
        alpha: boolean,
        acc: MaskPieces,
    ): string | null {
        for (const c of node.children ?? []) {
            if (c.type !== 'element' || !c.name || isNotRendered(c, this.foreign)) continue;
            for (const prop of ['filter', 'mask', 'clip-path'])
                if (!isNone(presentation(c, prop))) return `${prop} inside the mask`;
            const s = resolveStyle(c, style);
            const mm = childMatrix(c, m);
            if (GROUPS.has(c.name)) {
                const reason = this.flattenMask(c, s, mm, alpha, acc);
                if (reason) return reason;
                continue;
            }
            if (c.name !== 'path' && !SHAPE_NAMES.has(c.name)) return `<${c.name}> inside the mask`;
            const d = pathDataOf(c, this.viewport, this.precision);
            const fill = s.fill ?? '#000000'; // SVG's initial fill
            const stroked = !isNone(s.stroke) && strokeWidthOf(s) > 0;
            if (!d || isHidden(s) || (isNone(fill) && !stroked)) continue; // paints nothing
            if (stroked) acc.strokeIgnored = true;
            if (isNone(fill)) continue; // stroke-only: nothing left once the stroke is ignored
            if (/^url\(/i.test(fill.trim())) return 'gradient or pattern fill';
            const color = toAndroidColor(fill, s.fillOpacity * s.opacityMul, s.color);
            if (!color) return `fill "${fill}" is not a solid color`;
            if (!color.startsWith('#FF')) return 'translucent content';
            if (!alpha && color !== '#FFFFFFFF') return `fill "${fill}" is not white (luminance below 1)`;
            // Always transformed: the output is absolute, so pieces can be concatenated safely.
            const piece = transformPathData(d, mm ?? IDENTITY);
            if (s.fillRule !== 'evenodd') {
                acc.pieces.push(piece);
                continue;
            }
            // Positive orientation, like the pieces `unite` keeps or reverses: windings add up.
            const nonzero = evenOddToNonZero(piece, 1);
            if (nonzero === null) return 'fill-rule="evenodd" content with crossing or touching contours';
            acc.pieces.push(nonzero);
        }
        return null;
    }

    /** The mask region in the element's user space (null when a length cannot be resolved). */
    private maskRegion(attrs: Record<string, string>, bbox: Box | null, viewport: Viewport): Box | null {
        const get = (name: string, fallback: string): string => attrs[name] ?? fallback;
        const [x, y, w, h] = [get('x', '-10%'), get('y', '-10%'), get('width', '120%'), get('height', '120%')];
        const region = bbox
            ? {
                  x: bbox.x + fraction(x) * bbox.width,
                  y: bbox.y + fraction(y) * bbox.height,
                  width: fraction(w) * bbox.width,
                  height: fraction(h) * bbox.height,
              }
            : {
                  x: parseLength(x, viewport.width),
                  y: parseLength(y, viewport.height),
                  width: parseLength(w, viewport.width),
                  height: parseLength(h, viewport.height),
              };
        return Object.values(region).every(Number.isFinite) ? region : null;
    }

    /** Geometric bbox of `el` in its own user space (its transform excluded); null when unknown. */
    private elementBBox(el: XastElement, viewport: Viewport): Box | null {
        const pieces: string[] = [];
        if (GROUPS.has(el.name ?? '')) {
            if (!this.collectGeometry(el, null, viewport, pieces)) return null;
        } else {
            const d = pathDataOf(el, viewport, this.precision);
            if (d) pieces.push(d);
        }
        return unionBBox(pieces);
    }

    /** Collects a group's drawable geometry; false when it holds content whose extent is unknown. */
    private collectGeometry(node: XastElement, m: Matrix | null, viewport: Viewport, out: string[]): boolean {
        for (const c of node.children ?? []) {
            if (c.type !== 'element' || !c.name || isNotRendered(c, this.foreign)) continue;
            const mm = childMatrix(c, m);
            if (GROUPS.has(c.name)) {
                if (!this.collectGeometry(c, mm, viewport, out)) return false;
                continue;
            }
            if (c.name !== 'path' && !SHAPE_NAMES.has(c.name)) return false;
            const d = pathDataOf(c, viewport, this.precision);
            if (d) out.push(mm ? transformPathData(d, mm) : d);
        }
        return true;
    }

    private geometryOf(id: string, clip: XastElement): string | null {
        if (clip.attributes?.clipPathUnits === 'objectBoundingBox') {
            this.warn({
                code: 'unsupported-clip-path',
                message: `clipPath "${id}" uses clipPathUnits="objectBoundingBox"; ignored.`,
                node: 'clipPath',
            });
            return null;
        }
        const parts: string[] = [];
        this.flatten(clip, parseTransform(clip.attributes?.transform), parts, clipRuleOf(clip, 'nonzero'));
        const d = parts.join('') || null;
        if (!d)
            this.warn({
                code: 'unsupported-clip-path',
                message: `clipPath "${id}" produced no geometry; ignored.`,
                node: 'clipPath',
            });
        return d;
    }

    /**
     * Flattens a clipPath's content (shapes, paths, inlined `<use>` groups) into pathData pieces.
     * `clip-rule` is inherited (from the `<clipPath>` and groups). A VectorDrawable `<clip-path>` is
     * always nonzero, so an evenodd piece is rewritten into the same region under nonzero by orienting
     * its contours by nesting depth; every rewritten piece uses the same outer orientation, so pieces
     * add up (union) instead of cancelling.
     */
    private flatten(node: XastElement, m: Matrix | null, out: string[], rule: ClipRule): void {
        for (const c of node.children ?? []) {
            // Same filter as the renderer, the mask and bbox walks: <title>, foreign elements… draw nothing.
            if (c.type !== 'element' || !c.name || isNotRendered(c, this.foreign)) continue;
            const mm = childMatrix(c, m);
            const childRule = clipRuleOf(c, rule);
            if (GROUPS.has(c.name)) {
                this.flatten(c, mm, out, childRule);
                continue;
            }
            const raw = pathDataOf(c, this.viewport, this.precision);
            if (!raw) {
                this.warn({
                    code: 'unsupported-clip-path',
                    message: `<${c.name}> inside a <clipPath> cannot be converted; ignored.`,
                    node: 'clipPath',
                });
                continue;
            }
            const d = mm ? transformPathData(raw, mm) : raw;
            out.push(this.toNonZero(d, childRule, 'clipPath', 'clip-rule="evenodd"'));
        }
    }
}

/**
 * Concatenates nonzero pieces into one nonzero path covering their union. Overlapping pieces of
 * opposite windings would cancel where they meet (the mask paints each shape on its own): a piece
 * whose winding is negative everywhere is reversed. A piece whose sign cannot be proven (self-crossing
 * contours…) is kept as is. A single piece is returned unchanged.
 */
function unite(pieces: readonly string[]): string {
    if (pieces.length < 2) return pieces.join('');
    return pieces.map((d) => (windingSign(d) === -1 ? reversePathData(d) : d)).join('');
}

type ClipRule = 'nonzero' | 'evenodd';

/** The element's own `clip-rule`, or the inherited one. */
function clipRuleOf(el: XastElement, inherited: ClipRule): ClipRule {
    const v = presentation(el, 'clip-rule')?.trim();
    return v === 'evenodd' || v === 'nonzero' ? v : inherited;
}
