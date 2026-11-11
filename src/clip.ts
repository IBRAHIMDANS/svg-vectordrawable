import { srgbToLinear, toAndroidColor } from './color.js';
import { collectByName, GROUPS, isNotRendered, pathDataOf, switchChild, systemLanguageIgnored } from './elements.js';
import { escapeXml, formatNumber } from './format.js';
import type { XastElement } from './ast.js';
import { initialStyle, isHidden, resolveStyle, strokeWidthOf, USE_INSTANCE_ATTR, type Inherited } from './inherited.js';
import {
    evenOddToNonZero,
    matrixScale,
    normalizeArcFlags,
    pathBBox,
    reversePathData,
    scaledPrecision,
    transformPathData,
    windingSign,
} from './pathData.js';
import { compactPathData } from './pathContours.js';
import { toAbsolute } from './pathAbsolute.js';
import { parsePath } from './pathParse.js';
import { warnUnresolvedLength } from './paint.js';
import { shapeToPathData, SHAPE_NAMES, unresolvedShapeLengths } from './shapes.js';
import { isNone, presentation } from './style.js';
import { IDENTITY, isInvalidTransform, multiply, parseTransform, type Matrix } from './transform.js';
import type { Warning } from './types.js';
import { parseLength } from './units.js';
import type { Viewport } from './viewport.js';

type Box = { x: number; y: number; width: number; height: number };

/**
 * A mask resolved for one element: the clips that reproduce it (outermost first) and the uniform
 * mask value inside them (`opacity`, 1 for a white or opaque mask), or why it is not one.
 */
export type MaskClip = { clipIds: string[]; opacity: number } | { reason: string };

/**
 * Mask content flattened into clip pieces; `strokeIgnored` when a stroke of the content was left
 * out. Every piece paints the same mask `value`; `boxes` (one per piece) and `translucent` tell
 * whether overlapping pieces would compose into another value.
 */
interface MaskPieces {
    pieces: string[];
    boxes: Box[];
    strokeIgnored: boolean;
    /** An evenodd shape whose contours cross was filled nonzero (a larger region). */
    nonZeroUsed: boolean;
    value?: number;
    translucent: boolean;
    /** Clips of the mask of the one masked element making up the content (content space). */
    nested?: string[];
    /**
     * Opaque black shapes painted over the one rectangular piece, each entirely inside it: holes cut
     * out of it, oriented against it (winding -1 inside, 0 elsewhere) with their boxes (disjoint).
     */
    holes: string[];
    holeBoxes: Box[];
}

const emptyPieces = (): MaskPieces => ({
    pieces: [],
    boxes: [],
    strokeIgnored: false,
    nonZeroUsed: false,
    translucent: false,
    holes: [],
    holeBoxes: [],
});

/** A mask's content as registered clips (intersected), or why it is not clip-equivalent. */
type MaskContent =
    | {
          clipIds: string[];
          /** Null when the content renders nothing: the mask hides the element (see `EMPTY_CLIP`). */
          box: Box | null;
          strokeIgnored: boolean;
          nonZeroUsed: boolean;
          value: number;
      }
    | { reason: string };

/** A `<mask>` element and the style its content inherits (from the mask's own ancestors). */
interface MaskDef {
    el: XastElement;
    style: Inherited;
    /** `mask-type: alpha` (otherwise luminance). */
    alpha: boolean;
    /** `color-interpolation` computes to `linearRGB` on the `<mask>` (luminance of linearized colors). */
    linearRgb: boolean;
}

/** Two mask values closer than this are the same (8-bit colors differ by 1/255 at least). */
const VALUE_EPSILON = 1e-3;

/**
 * The luminance of an opaque `#AARRGGBB` color, as `mask-type: luminance` reads it (CSS Masking 1
 * §7.10.1 "Mask processing": the luminance-to-alpha coefficients of SVG 1.1 `feColorMatrix`, applied
 * to the non-premultiplied color values, converted to linearRGB first only when `color-interpolation`
 * on the mask element is `linearRGB`; the default `sRGB` uses the encoded values as they are).
 * Chrome and Firefox agree on the linearized value (`#808080` reads 0.216 instead of 0.502).
 */
function luminanceOf(color: string, linearRgb: boolean): number {
    const channel = (i: number): number => {
        const c = parseInt(color.slice(i, i + 2), 16) / 255;
        return linearRgb ? srgbToLinear(c) : c;
    };
    return 0.2125 * channel(3) + 0.7154 * channel(5) + 0.0721 * channel(7);
}

/** `color-interpolation` keywords that set the property; anything else defers to the parent. */
const INTERPOLATION_VALUES = new Set(['auto', 'srgb', 'linearrgb', 'initial']);

/**
 * true when `color-interpolation` (inherited) computes to `linearRGB` on the first of `nodes` (the
 * element, then its ancestors nearest first): the nearest one setting it decides.
 */
function isLinearRgb(nodes: readonly XastElement[]): boolean {
    for (const node of nodes) {
        const value = presentation(node, 'color-interpolation')?.trim().toLowerCase();
        if (value !== undefined && INTERPOLATION_VALUES.has(value)) return value === 'linearrgb';
    }
    return false;
}

/**
 * True when a shape of mask content paints a visible stroke: a stroke `none`, of zero width, or
 * fully transparent (color alpha, `stroke-opacity`, `opacity`) paints nothing, so ignoring it is no
 * approximation. An unresolved color (`currentColor` unknown) counts as visible.
 */
function paintsMaskStroke(s: Inherited): boolean {
    if (isNone(s.stroke) || !(strokeWidthOf(s) > 0)) return false;
    const opacity = s.strokeOpacity * s.opacityMul;
    if (/^url\(/i.test(s.stroke!.trim())) return opacity > 0;
    const color = toAndroidColor(s.stroke, opacity, s.color);
    return color === null || !color.startsWith('#00');
}

/** Interiors of two boxes intersect (touching edges do not overlap). */
const overlaps = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width - EPSILON &&
    b.x < a.x + a.width - EPSILON &&
    a.y < b.y + b.height - EPSILON &&
    b.y < a.y + a.height - EPSILON;

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

/**
 * The geometry of a clip that clips everything: a `<clipPath>` with no rendered child (CSS Masking 1
 * §6.1: an empty clipping path "completely clips away the element"). A zero-area contour, so that a
 * VectorDrawable clipped by it draws nothing; `wrapClip` drops the content instead.
 */
const EMPTY_CLIP = 'M0,0Z';

/** True when `d` encloses no area (its bounding box is flat or absent): it clips everything. */
export function clipsEverything(d: string): boolean {
    const box = pathBBox(d);
    return !box || box.width <= EPSILON || box.height <= EPSILON;
}

/** Renders a `<clip-path>` element at `indent`. */
export const clipPathElement = (d: string, indent: string): string =>
    `${indent}<clip-path android:pathData="${escapeXml(normalizeArcFlags(d))}" />`;

/** Wraps already-rendered content in a `<group>` clipped by `d`; nothing when `d` clips everything. */
export const wrapClip = (d: string, body: string, pad: string, step: string): string =>
    clipsEverything(d)
        ? ''
        : `${pad}<group>\n${clipPathElement(d, pad + step)}\n${body.replace(/^/gm, step)}\n${pad}</group>`;

/**
 * The document's `<clipPath>` elements, resolved on demand into one pathData each per precision
 * (cached, so a clip shared by several elements is reported once). Also hosts the synthetic viewport
 * clips of nested `<svg>` elements.
 */
export class ClipPaths {
    private readonly byId = new Map<string, XastElement>();
    /** Geometry of each `<clipPath>`, keyed by `<precision>:<id>` (see `resolve`). */
    private readonly cache = new Map<string, string | null>();
    /** `<clipPath>` ids already resolved at some precision: their warnings are not repeated. */
    private readonly resolvedIds = new Set<string>();
    /** Geometry of the clips registered already resolved (`addResolvedClip`), by id. */
    private readonly resolvedClips = new Map<string, string>();
    /** True while a clip already reported is resolved again at another precision. */
    private muted = false;
    private readonly masks = new Map<string, MaskDef>();
    /** Mask content resolved once per mask (userSpaceOnUse content does not depend on the element). */
    private readonly maskContents = new Map<string, MaskContent>();
    /** Masks already reported as `mask-approximated` (once per mask, whatever the units). */
    private readonly approximatedMasks = new Set<string>();
    /** Masks already reported for evenodd content filled nonzero (once per mask). */
    private readonly nonZeroMasks = new Set<string>();
    /** `resolveMask` results per element: the opacity of a translucent mask is applied once. */
    private readonly resolvedMasks = new WeakMap<XastElement, MaskClip>();
    /** Masks whose content is being flattened: a mask used inside its own content is refused. */
    private readonly resolvingMasks = new Set<string>();
    /** Clip and mask content already reported for its `systemLanguage` (once per element). */
    private readonly languageReported = new WeakSet<XastElement>();
    /** `<clipPath>` and clip or mask content already reported for an invalid `transform` (once per element). */
    private readonly transformReported = new WeakSet<XastElement>();
    private syntheticCount = 0;
    constructor(
        svgEl: XastElement,
        private readonly report: (w: Warning) => void,
        /** Percentages inside a clipPath resolve against the root viewport. */
        private readonly viewport: Viewport,
        private readonly precision: number,
        /** Elements outside the SVG namespace (`ctx.foreign`): skipped by every walk, like the renderer. */
        private readonly foreign: WeakSet<XastElement>,
    ) {
        const clipEls: XastElement[] = [];
        collectByName(svgEl, new Set(['clipPath']), clipEls);
        for (const clip of clipEls) {
            const id = clip.attributes?.id;
            if (id && !this.byId.has(id)) this.byId.set(id, clip);
        }
        this.collectMasks(svgEl, [svgEl]);
    }

    /** Reports `w`, unless a clip already reported is being resolved again (see `muted`). */
    private readonly warn = (w: Warning): void => {
        if (!this.muted) this.report(w);
    };

    /**
     * Resolves the `clip-path` of `el` (a group or drawable leaf whose computed style is `style`)
     * into pathData in its user space (after its own transform), with numbers at `precision`
     * decimals (that of the content drawn there: more under a scale above 1, see render.ts
     * `scaledContentPrecision`); null when absent or unusable. Read
     * like any presentation property (inline `style` first, where svgo inlines `<style>` rules, then
     * the attribute); never inherited, so only the element's own attributes count. `url(#id)` and the
     * CSS basic shapes (see `resolveShape`) are converted; anything else (a reference box alone, an
     * external url…) is reported as `unsupported-clip-path`.
     */
    resolve(el: XastElement, style: Inherited, precision = this.precision): string | null {
        const value = (presentation(el, 'clip-path') ?? '').trim();
        if (!value || NO_CLIP.has(value.toLowerCase())) return null;
        const shape = BASIC_SHAPE.exec(value);
        if (shape && shape[2]!.toLowerCase() !== 'url') return this.resolveShape(el, style, value, shape, precision);
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
        const resolved = this.resolvedClips.get(id);
        if (resolved !== undefined) return resolved;
        const key = `${precision}:${id}`;
        if (!this.cache.has(key)) {
            this.muted = this.resolvedIds.has(id);
            try {
                this.cache.set(key, this.geometryOf(id, clip, precision));
            } finally {
                this.muted = false;
            }
            this.resolvedIds.add(id);
        }
        return this.cache.get(key)!;
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
    private resolveShape(
        el: XastElement,
        style: Inherited,
        value: string,
        match: RegExpExecArray,
        precision: number,
    ): string | null {
        const shape = this.shapeGeometry(el, style, match, precision);
        if ('reason' in shape) {
            this.warnClip(value, shape.reason);
            return null;
        }
        return this.toNonZero(shape.d, shape.rule, 'clip-path', 'fill-rule="evenodd" in polygon()');
    }

    private shapeGeometry(el: XastElement, style: Inherited, match: RegExpExecArray, precision: number): ShapeGeometry {
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
        const box = this.elementBBox(el, style.viewport, precision);
        if (!box) return { reason: 'needs the bounding box of the element, which is unknown' };
        return basicShape(fn!.toLowerCase(), args!.toLowerCase(), box, precision);
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
     * every piece, so pieces add up (union) instead of cancelling. Contours that cross have no
     * such rewrite: reported, and nonzero is used.
     */
    private toNonZero(d: string, rule: ClipRule, node: string, what: string): string {
        if (rule !== 'evenodd') return d;
        const nonzero = evenOddToNonZero(d, 1);
        if (nonzero === null)
            this.warn({
                code: 'unsupported-clip-path',
                message: `${what} with crossing contours has no nonzero equivalent in a VectorDrawable <clip-path>; nonzero is used.`,
                node,
            });
        return nonzero ?? d;
    }

    /**
     * Reports the shape lengths of clip or mask content that cannot be resolved, as the renderer
     * does for drawn shapes (once per message and conversion: `warnUnresolvedLength` keys on `warn`).
     */
    private warnShapeLengths(el: XastElement): void {
        if (!SHAPE_NAMES.has(el.name!) || this.muted) return;
        const ctx = { warn: this.report };
        for (const u of unresolvedShapeLengths(el.name!, el.attributes ?? {}, this.viewport))
            warnUnresolvedLength(ctx, u.attr, u.value, el.name!, u.fallback);
    }

    /**
     * Reports a non-empty `systemLanguage` on clip or mask content, as the renderer does for drawn
     * elements: it depends on the device language, so the element is used as if it passed (an empty
     * one never renders, see `isNotRendered`). Once per element.
     */
    private warnSystemLanguage(el: XastElement): void {
        if (el.attributes?.systemLanguage === undefined || this.languageReported.has(el)) return;
        this.languageReported.add(el);
        this.warn({
            code: 'unsupported-attribute',
            message: systemLanguageIgnored(el.name!),
            node: el.name!,
        });
    }

    /**
     * Reports an invalid `transform` list on a `<clipPath>` or on clip or mask content, as the
     * renderer does for drawn elements: it is ignored (the element is used untransformed, as in a
     * browser). Once per element.
     */
    private warnInvalidTransform(el: XastElement): void {
        const transform = el.attributes?.transform;
        if (!isInvalidTransform(transform) || this.transformReported.has(el)) return;
        this.transformReported.add(el);
        this.warn({
            code: 'unsupported-attribute',
            // Same message as render.ts `reportUnsupportedAttrs` (not imported: render.ts imports this module).
            message: `transform="${transform}" on <${el.name}> is not a valid transform list; ignored.`,
            node: el.name!,
        });
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

    /**
     * Registers a clip whose geometry is already resolved and returns its unique id. The geometry is
     * written compactly (a clip only fills: closing open subpaths keeps its region); `EMPTY_CLIP`,
     * which draws nothing, stays as is. Its numbers already carry `precision` decimals (`pathDataOf`)
     * or `max(precision, 3)` (`transformPathData`): rounding to the larger of the two never coarsens them.
     */
    private addResolvedClip(prefix: string, d: string, precision: number): string {
        const id = this.uniqueId(prefix);
        this.byId.set(id, { type: 'element', name: 'clipPath', attributes: { id }, children: [] });
        this.resolvedClips.set(id, compactPathData(d, this.transformedPrecision(precision)) || d);
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
                this.masks.set(id, {
                    el: c,
                    // Opacity is not inherited: only the mask's own (and its content's) counts.
                    style: resolveStyle(c, { ...style, opacityMul: 1 }),
                    alpha: (presentation(c, 'mask-type') ?? '').trim() === 'alpha',
                    linearRgb: isLinearRgb([c, ...[...ancestors].reverse()]),
                });
            }
            this.collectMasks(c, [...ancestors, c]);
        }
    }

    /**
     * Resolves the `mask` of `el` (a group or drawable leaf) into clips, when the mask is
     * *clip-equivalent*: its mask value is one uniform value `v` inside some shapes and 0 elsewhere,
     * which is a VectorDrawable `<clip-path>` (nonzero rule) around the element drawn at `v` times its
     * opacity. When `v` < 1, the `opacity` of `el` is multiplied by `v` here (once per element), so the
     * renderer folds it like any opacity (onto the leaves: a VectorDrawable group has no alpha; with
     * `opacity-approximated` when the children of a group overlap). That holds when:
     * - `mask-type` is `luminance` (default) and every painting shape has the same luminance × alpha
     *   (see `luminanceOf`), or `mask-type` is `alpha` and every painting shape has the same alpha;
     * - the alpha covers the fill color alpha, `fill-opacity` and `opacity` (own and inherited
     *   inside the mask; ancestors of the `<mask>` only pass inherited properties down); translucent
     *   shapes must not overlap (their values would compose into another one where they do);
     * - no shape paints a gradient / pattern fill, or carries a `filter` / `clip-path`; only groups,
     *   paths and basic shapes (`<use>` is already inlined as groups; a `<switch>` stands for the
     *   child it picks) appear. Shapes that paint
     *   nothing (fill and stroke `none` or fully transparent, `display: none`, hidden, empty
     *   geometry) are ignored;
     * - a `mask` inside the content must be clip-equivalent itself: an element under it that only
     *   paints (ignored) strokes is dropped; the element making up the whole content may carry one,
     *   whose clips are intersected (nested clips) and whose value multiplies the content's;
     * - strokes are the one approximation: a clip-path has no stroke outline, so the stroke of the
     *   content is ignored (`mask-approximated`, once per mask) and a stroke-only shape is dropped;
     *   content left empty that way refuses the mask;
     * - a `fill-rule="evenodd"` shape is rewritten into the same region under nonzero (a clip-path is
     *   nonzero); when its contours cross, it is filled nonzero instead (a larger region),
     *   reported as `unsupported-attribute` like an evenodd clip-path, once per mask;
     * - one exception to the uniform value, under `luminance`: opaque black shapes painted over a single
     *   rectangle, each entirely inside it, cut holes in it (a Figma "outside stroke" mask; see `cutHole`);
     * - `maskContentUnits` is `userSpaceOnUse` (default: the element's user space) or
     *   `objectBoundingBox` (content mapped onto the element's bbox);
     * - the mask region (`x`/`y`/`width`/`height`, `maskUnits` defaulting to objectBoundingBox
     *   -10 % / -10 % / 120 % / 120 %) also clips: when it cuts the content, a rectangular clip is
     *   added (nested Android clips intersect).
     * The clips live in the element's user space (after its own transform), like its clip-path, with
     * numbers at `precision` decimals (that of the content drawn there, see `resolve`).
     */
    resolveMask(el: XastElement, viewport: Viewport, precision = this.precision): MaskClip {
        const known = this.resolvedMasks.get(el);
        if (known) return known;
        const mask = this.maskClip(el, viewport, precision);
        this.resolvedMasks.set(el, mask);
        return mask;
    }

    /** The mask as clips and a uniform value (also used for a mask inside mask content). */
    private maskClip(el: XastElement, viewport: Viewport, precision: number): MaskClip {
        const ref = URL_REF.exec((presentation(el, 'mask') ?? '').trim());
        if (!ref) return { reason: 'not a url(#id) reference' };
        const id = ref[1]!;
        const mask = this.masks.get(id);
        if (!mask) return { reason: `unknown mask "${id}"` };
        if (this.resolvingMasks.has(id)) return { reason: `mask "${id}" is used inside its own content` };
        const attrs = mask.el.attributes ?? {};
        const type = (presentation(mask.el, 'mask-type') ?? 'luminance').trim();
        if (type !== 'luminance' && type !== 'alpha') return { reason: `mask-type="${type}"` };

        const boxUnits = attrs.maskUnits !== 'userSpaceOnUse';
        const boxContent = attrs.maskContentUnits === 'objectBoundingBox';
        let bbox: Box | null = null;
        if (boxUnits || boxContent) {
            bbox = this.elementBBox(el, viewport, precision);
            if (!bbox || bbox.width <= 0 || bbox.height <= 0)
                return { reason: 'its objectBoundingBox units need a non-empty bounding box' };
        }

        const key = `${precision}:${id}`;
        let content = boxContent ? undefined : this.maskContents.get(key);
        if (!content) {
            const m = boxContent ? { a: bbox!.width, b: 0, c: 0, d: bbox!.height, e: bbox!.x, f: bbox!.y } : null;
            this.resolvingMasks.add(id);
            content = this.maskContent(mask, m, precision);
            this.resolvingMasks.delete(id);
            if (!boxContent) this.maskContents.set(key, content);
        }
        if ('reason' in content) return content;
        // Nothing rendered: the mask value is 0 everywhere, whatever the region.
        if (!content.box) return { clipIds: content.clipIds, opacity: 1 };

        const region = this.maskRegion(attrs, boxUnits ? bbox : null, viewport);
        if (!region) return { reason: 'its region (x/y/width/height) cannot be resolved' };
        const inside = contains(region, content.box);
        const { x, y, width, height } = region;
        if (!inside && (width <= 0 || height <= 0)) return { reason: 'its region is empty' };
        if (content.strokeIgnored) this.reportApproximatedMask(id);
        if (content.nonZeroUsed) this.reportNonZeroMask(id);
        const opacity = content.value;
        if (inside) return { clipIds: content.clipIds, opacity };
        const rect = `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
        return { clipIds: [...content.clipIds, this.addResolvedClip('svgvd-mask-region', rect, precision)], opacity };
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

    /** Warns once per mask that evenodd content with crossing contours was filled nonzero. */
    private reportNonZeroMask(id: string): void {
        if (this.nonZeroMasks.has(id)) return;
        this.nonZeroMasks.add(id);
        this.warn({
            code: 'unsupported-attribute',
            message: `mask "${id}": fill-rule="evenodd" content with crossing contours has no nonzero equivalent in a VectorDrawable <clip-path>; nonzero is used.`,
            node: 'mask',
        });
    }

    /** The mask content as registered clips, or why it is not clip-equivalent. */
    private maskContent(mask: MaskDef, m: Matrix | null, precision: number): MaskContent {
        const acc = emptyPieces();
        const reason = this.flattenMask(mask.el, mask.style, m, mask, acc, precision);
        if (reason) return { reason };
        const box = unionBBox(acc.pieces);
        if (!box && acc.strokeIgnored)
            return { reason: 'its content only paints strokes, which a clip-path cannot draw' };
        // No rendered content (CSS Masking 1 §7.1: the mask value is 0 outside it): the element is hidden.
        if (!box)
            return {
                clipIds: [this.addResolvedClip('svgvd-mask', EMPTY_CLIP, precision)],
                box: null,
                strokeIgnored: false,
                nonZeroUsed: false,
                value: 1,
            };
        if (acc.translucent && acc.boxes.some((a, i) => acc.boxes.slice(i + 1).some((b) => overlaps(a, b))))
            return { reason: 'translucent content with overlapping shapes (their mask values compose)' };
        const [rect] = acc.pieces;
        // Holes: the rectangle oriented positively (winding 1), then each hole against it (1 - 1 = 0).
        const d = acc.holes.length
            ? (windingSign(rect!) === -1 ? reversePathData(rect!) : rect!) + acc.holes.join('')
            : unite(acc.pieces);
        return {
            clipIds: [this.addResolvedClip('svgvd-mask', d, precision), ...(acc.nested ?? [])],
            box,
            strokeIgnored: acc.strokeIgnored,
            nonZeroUsed: acc.nonZeroUsed,
            value: acc.value ?? 1,
        };
    }

    /**
     * Flattens clip-equivalent mask content (the children of `node`) into pathData pieces (each starts with an absolute `M`);
     * returns a reason otherwise. Strokes are left out (flagged in `acc.strokeIgnored`): only fills
     * become pieces.
     */
    private flattenMask(
        node: XastElement,
        style: Inherited,
        m: Matrix | null,
        def: MaskDef,
        acc: MaskPieces,
        precision: number,
    ): string | null {
        for (const c of node.children ?? []) {
            if (c.type !== 'element' || !c.name || isNotRendered(c, this.foreign)) continue;
            this.warnSystemLanguage(c);
            this.warnInvalidTransform(c);
            const reason = isNone(presentation(c, 'mask'))
                ? this.flattenElement(c, style, m, def, acc, precision)
                : this.flattenMasked(c, style, m, def, acc, precision);
            if (reason) return reason;
        }
        return null;
    }

    /**
     * A masked element `c` of mask content, under a mask that must be clip-equivalent itself (each
     * level exact). Only its fills count (see `flattenElement`): with none (only ignored strokes), it
     * is dropped. Otherwise it must make up the whole content: its clips (moved into the content
     * space) intersect the content's, its value multiplies it.
     */
    private flattenMasked(
        c: XastElement,
        style: Inherited,
        m: Matrix | null,
        def: MaskDef,
        acc: MaskPieces,
        precision: number,
    ): string | null {
        const own = emptyPieces();
        const reason = this.flattenElement(c, style, m, def, own, precision);
        if (reason) return reason;
        if (!own.pieces.length && !own.strokeIgnored) return null; // paints nothing
        if (own.pieces.length && (acc.pieces.length || acc.nested))
            return 'a masked element next to other content inside the mask';
        const mm = childMatrix(c, m);
        // Each level must be exact: an inexact inner mask (a Figma outside stroke…) is no clip either.
        // Its clips live in the user space of `c`, which `mm` maps into the content space.
        const inner = this.maskClip(c, this.viewport, this.contentPrecision(precision, mm));
        if ('reason' in inner) return `mask inside the mask (${inner.reason})`;
        if (own.strokeIgnored) acc.strokeIgnored = true;
        if (own.nonZeroUsed) acc.nonZeroUsed = true;
        if (!own.pieces.length) return null; // only strokes, ignored like any other
        acc.nested = mm
            ? inner.clipIds.map((id) =>
                  this.addResolvedClip(
                      'svgvd-mask',
                      transformPathData(this.resolvedClips.get(id)!, mm, this.transformedPrecision(precision)),
                      precision,
                  ),
              )
            : inner.clipIds;
        acc.pieces.push(...own.pieces);
        acc.boxes.push(...own.boxes);
        acc.holes = own.holes;
        acc.holeBoxes = own.holeBoxes;
        acc.translucent = own.translucent;
        acc.value = (own.value ?? 1) * inner.opacity;
        return null;
    }

    /** Flattens one element of mask content (its own `mask` aside) into `acc`; a reason otherwise. */
    private flattenElement(
        c: XastElement,
        style: Inherited,
        m: Matrix | null,
        def: MaskDef,
        acc: MaskPieces,
        precision: number,
    ): string | null {
        for (const prop of ['filter', 'clip-path'])
            if (!isNone(presentation(c, prop))) return `${prop} inside the mask`;
        const s = resolveStyle(c, style);
        const mm = childMatrix(c, m);
        if (GROUPS.has(c.name!)) return this.flattenMask(c, s, mm, def, acc, precision);
        if (c.name === 'switch') {
            // Rendered as a group around the one child it picks (see render.ts `switchAsGroup`).
            const { child } = switchChild(c, this.foreign);
            return this.flattenMask({ ...c, children: child ? [child] : [] }, s, mm, def, acc, precision);
        }
        if (c.name !== 'path' && !SHAPE_NAMES.has(c.name!)) return `<${c.name}> inside the mask`;
        if (!isHidden(s)) this.warnShapeLengths(c);
        // objectBoundingBox content is scaled by the bbox size: more decimals for a large box.
        const d = pathDataOf(c, this.viewport, this.contentPrecision(precision, mm));
        if (!d || isHidden(s)) return null; // paints nothing
        if (paintsMaskStroke(s)) acc.strokeIgnored = true;
        const fill = s.fill ?? '#000000'; // SVG's initial fill
        if (isNone(fill)) return null; // nothing, or nothing left once the stroke is ignored
        if (/^url\(/i.test(fill.trim())) return 'gradient or pattern fill';
        const color = toAndroidColor(fill, s.fillOpacity * s.opacityMul, s.color);
        if (!color) return `fill "${fill}" is not a solid color`;
        const alpha = parseInt(color.slice(1, 3), 16) / 255;
        if (alpha === 0) return null; // a fully transparent fill paints nothing
        let value = alpha;
        if (!def.alpha) {
            value *= luminanceOf(color, def.linearRgb);
        }
        if (acc.nested) return 'a masked element next to other content inside the mask';
        // An opaque black shape (luminance 0) over a white rectangle: a Figma "outside stroke" mask.
        if (value < VALUE_EPSILON && alpha === 1 && this.cutHole(d, s, mm, acc, precision)) return null;
        if (acc.holes.length && value >= VALUE_EPSILON)
            return `fill "${fill}" paints over a hole cut by a black shape (not uniform)`;
        if (acc.value !== undefined && Math.abs(acc.value - value) > VALUE_EPSILON)
            return `fill "${fill}" gives another mask value than the rest of the content (not uniform)`;
        acc.value ??= value;
        if (alpha < 1) acc.translucent = true;
        // Always transformed; each piece starts with an absolute M, so pieces can be concatenated safely.
        let piece = transformPathData(d, mm ?? IDENTITY, this.transformedPrecision(precision));
        if (s.fillRule === 'evenodd') {
            // Positive orientation, like the pieces `unite` keeps or reverses: windings add up.
            // Crossing contours have no such rewrite: filled nonzero (reported), like a clip-path.
            const nonzero = evenOddToNonZero(piece, 1);
            if (nonzero === null) acc.nonZeroUsed = true;
            else piece = nonzero;
        }
        acc.pieces.push(piece);
        const box = pathBBox(piece);
        if (box) acc.boxes.push(box);
        return null;
    }

    /**
     * Cuts the opaque black shape `d` (painted last, luminance 0) out of the content when that is
     * provably exact as a nonzero clip: the content so far is one rectangle (winding 1 once oriented,
     * see `isRectangle`), the shape lies entirely inside it, its winding is 0 or 1 everywhere once
     * oriented (evenodd rewritten so; a nonzero shape must already alternate its nested contours) and
     * it does not overlap another hole. The rectangle plus the reversed shape then winds 1 outside the
     * holes and 0 inside them. False (nothing recorded) otherwise.
     */
    private cutHole(d: string, s: Inherited, mm: Matrix | null, acc: MaskPieces, precision: number): boolean {
        const [rect] = acc.pieces;
        const box = acc.boxes[0];
        if (acc.pieces.length !== 1 || acc.boxes.length !== 1 || !isRectangle(rect!, box!)) return false;
        const piece = transformPathData(d, mm ?? IDENTITY, this.transformedPrecision(precision));
        const evenodd = s.fillRule === 'evenodd';
        const oriented = evenOddToNonZero(piece, evenodd ? 1 : undefined);
        if (oriented === null || (!evenodd && oriented !== piece)) return false;
        const sign = windingSign(oriented);
        const hole = pathBBox(oriented);
        if (!sign || !hole || !contains(box!, hole) || acc.holeBoxes.some((b) => overlaps(b, hole))) return false;
        acc.holes.push(sign === 1 ? reversePathData(oriented) : oriented);
        acc.holeBoxes.push(hole);
        return true;
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

    /**
     * Geometric bbox of `el` in its own user space (its transform excluded), measured on geometry at
     * `precision` decimals (that of the content drawn there); null when unknown.
     */
    private elementBBox(el: XastElement, viewport: Viewport, precision: number): Box | null {
        const pieces: string[] = [];
        if (GROUPS.has(el.name ?? '') || el.name === 'switch') {
            if (!this.collectGeometry(el, null, viewport, pieces, precision)) return null;
        } else {
            const d = pathDataOf(el, viewport, precision);
            if (d) pieces.push(d);
        }
        return unionBBox(pieces);
    }

    /**
     * Collects the drawable geometry of a group, or of a `<switch>` (the one child `switchChild`
     * picks, as rendered; none gives no geometry, like an empty group); false when it holds content
     * whose extent is unknown.
     */
    private collectGeometry(
        node: XastElement,
        m: Matrix | null,
        viewport: Viewport,
        out: string[],
        precision: number,
    ): boolean {
        const picked = node.name === 'switch' ? switchChild(node, this.foreign).child : undefined;
        const children = node.name === 'switch' ? (picked ? [picked] : []) : node.children;
        for (const c of children ?? []) {
            if (c.type !== 'element' || !c.name || isNotRendered(c, this.foreign)) continue;
            const mm = childMatrix(c, m);
            if (GROUPS.has(c.name) || c.name === 'switch') {
                if (!this.collectGeometry(c, mm, viewport, out, precision)) return false;
                continue;
            }
            if (c.name !== 'path' && !SHAPE_NAMES.has(c.name)) return false;
            const d = pathDataOf(c, viewport, this.contentPrecision(precision, mm));
            if (d) out.push(mm ? transformPathData(d, mm, this.transformedPrecision(precision)) : d);
        }
        return true;
    }

    /**
     * Precision of clip or mask content mapped by `m` into a space drawn at `precision`: its
     * coordinates are multiplied by the scale of `m` (a `<clipPath transform="scale(1000)">`, an
     * objectBoundingBox mask…), so they keep that many more decimals (`scaledPrecision`).
     */
    private contentPrecision(precision: number, m: Matrix | null): number {
        return m ? scaledPrecision(precision, matrixScale(m)) : precision;
    }

    /** Precision of geometry mapped by `transformPathData`: never fewer than its former fixed 3 decimals. */
    private transformedPrecision(precision: number): number {
        return Math.max(precision, 3);
    }

    private geometryOf(id: string, clip: XastElement, precision: number): string | null {
        if (clip.attributes?.clipPathUnits === 'objectBoundingBox') {
            this.warn({
                code: 'unsupported-clip-path',
                message: `clipPath "${id}" uses clipPathUnits="objectBoundingBox"; ignored.`,
                node: 'clipPath',
            });
            return null;
        }
        this.warnInvalidTransform(clip);
        const parts: string[] = [];
        const converted = this.flatten(
            clip,
            parseTransform(clip.attributes?.transform),
            parts,
            clipRuleOf(clip, 'nonzero'),
            precision,
        );
        // Nothing rendered in it: the clip is empty and clips everything, as in a browser.
        if (converted && !parts.length) return EMPTY_CLIP;
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
     * add up (union) instead of cancelling. Neither a `<switch>` nor a `<g>` / `<a>` is a permitted
     * child (SVG 2 §14.3.5): ignored, as Chrome does (Firefox drops the whole clip, which then clips
     * everything); svgo removes such a `<g>` too. The group wrapping an inlined `<use>` is the `<use>`
     * itself, a permitted child: kept. A `<use>` in a `<clipPath>` must reference a shape or a text
     * (CSS Masking 1 §6.1): an instance of a `<g>`, `<symbol>`, `<svg>` or another `<use>` (its clone is
     * then a group, an `<svg>` or a nested instance) contributes nothing, as in Chrome and Firefox.
     * False when some content could not be converted (reported).
     */
    private flatten(node: XastElement, m: Matrix | null, out: string[], rule: ClipRule, precision: number): boolean {
        let converted = true;
        const isClip = node.name === 'clipPath';
        const isInstance = node.attributes?.[USE_INSTANCE_ATTR] !== undefined;
        for (const c of node.children ?? []) {
            // Same filter as the renderer, the mask and bbox walks: <title>, foreign elements… draw nothing.
            if (c.type !== 'element' || !c.name || c.name === 'switch' || isNotRendered(c, this.foreign)) continue;
            if (isClip && GROUPS.has(c.name) && c.attributes?.[USE_INSTANCE_ATTR] === undefined) continue;
            if (isInstance && (GROUPS.has(c.name) || c.name === 'svg')) continue;
            const mm = childMatrix(c, m);
            const childRule = clipRuleOf(c, rule);
            this.warnSystemLanguage(c);
            this.warnInvalidTransform(c);
            if (GROUPS.has(c.name)) {
                if (!this.flatten(c, mm, out, childRule, precision)) converted = false;
                continue;
            }
            this.warnShapeLengths(c);
            const raw = pathDataOf(c, this.viewport, this.contentPrecision(precision, mm));
            // A shape or path without geometry (zero size, no `d`…) renders nothing, as in a browser.
            if (!raw && (c.name === 'path' || SHAPE_NAMES.has(c.name))) continue;
            if (!raw) {
                this.warn({
                    code: 'unsupported-clip-path',
                    message: `<${c.name}> inside a <clipPath> cannot be converted; ignored.`,
                    node: 'clipPath',
                });
                converted = false;
                continue;
            }
            const d = mm ? transformPathData(raw, mm, this.transformedPrecision(precision)) : raw;
            out.push(this.toNonZero(d, childRule, 'clipPath', 'clip-rule="evenodd"'));
        }
        return converted;
    }
}

/**
 * True when `d` is one contour of straight lines through the four corners of its bounding box `box`,
 * each to an adjacent one: it goes once around the box, so its winding is ±1 inside and 0 outside.
 */
function isRectangle(d: string, box: Box): boolean {
    if (box.width <= EPSILON || box.height <= EPSILON) return false;
    const commands = toAbsolute(parsePath(d));
    const points: [number, number][] = [];
    for (const [i, { cmd, args }] of commands.entries()) {
        if (cmd === 'Z' ? i !== commands.length - 1 : cmd !== (i === 0 ? 'M' : 'L')) return false;
        if (cmd !== 'Z') points.push([args[0]!, args[1]!]);
    }
    const [first, last] = [points[0], points[points.length - 1]];
    if (points.length === 5 && first![0] === last![0] && first![1] === last![1]) points.pop();
    if (points.length !== 4) return false;
    const side = (v: number, lo: number, size: number): number =>
        Math.abs(v - lo) <= EPSILON ? 0 : Math.abs(v - lo - size) <= EPSILON ? 1 : -1;
    const corners = points.map(([x, y]) => [side(x, box.x, box.width), side(y, box.y, box.height)] as const);
    if (corners.some(([x, y]) => x < 0 || y < 0)) return false;
    // Adjacent corners differ on one side; four steps that each change one side visit all four corners.
    return (
        corners.every(([x, y], i) => {
            const [nx, ny] = corners[(i + 1) % 4]!;
            return (x !== nx) !== (y !== ny);
        }) && new Set(corners.map(([x, y]) => 2 * x + y)).size === 4
    );
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
