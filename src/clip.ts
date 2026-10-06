import { toAndroidColor } from './color.js';
import { collectByName, GROUPS, isDisplayNone, pathDataOf, SKIP } from './elements.js';
import { escapeXml } from './format.js';
import type { XastElement } from './gradient.js';
import { initialStyle, isHidden, resolveStyle, strokeWidthOf, type Inherited } from './inherited.js';
import { evenOddToNonZero, normalizeArcFlags, pathBBox, transformPathData } from './pathData.js';
import { SHAPE_NAMES } from './shapes.js';
import { isNone, presentation } from './style.js';
import { IDENTITY, multiply, parseTransform, type Matrix } from './transform.js';
import type { Warning } from './types.js';
import { parseLength } from './units.js';
import type { Viewport } from './viewport.js';

type Box = { x: number; y: number; width: number; height: number };

/** A mask resolved for one element: the clips that reproduce it (outermost first), or why it is not one. */
export type MaskClip = { clipIds: string[] } | { reason: string };

/** A `<mask>` element and the style its content inherits (from the mask's own ancestors). */
interface MaskDef {
    el: XastElement;
    style: Inherited;
}

const URL_REF = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/;

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
    private readonly maskContents = new Map<string, { clipId: string; box: Box } | { reason: string }>();
    private syntheticCount = 0;

    constructor(
        svgEl: XastElement,
        private readonly warn: (w: Warning) => void,
        /** Percentages inside a clipPath resolve against the root viewport. */
        private readonly viewport: Viewport,
        private readonly precision: number,
    ) {
        const clipEls: XastElement[] = [];
        collectByName(svgEl, new Set(['clipPath']), clipEls);
        for (const clip of clipEls) {
            const id = clip.attributes?.id;
            if (id && !this.byId.has(id)) this.byId.set(id, clip);
        }
        this.collectMasks(svgEl, [svgEl]);
    }

    /** Resolves an element's `clip-path="url(#id)"` into pathData; null when absent or unusable. */
    resolve(attrs: Record<string, string>): string | null {
        const m = /^url\(#([^)]+)\)/.exec((attrs['clip-path'] ?? '').trim());
        if (!m) return null;
        const id = m[1]!;
        const clip = this.byId.get(id);
        if (!clip) {
            this.warn({ code: 'missing-clip-path', message: `Unknown clip-path "${id}"; ignored.`, node: 'clip-path' });
            return null;
        }
        if (!this.cache.has(id)) this.cache.set(id, this.geometryOf(id, clip));
        return this.cache.get(id)!;
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
     * - no shape paints a stroke, a gradient / pattern, uses `fill-rule="evenodd"` (a clip-path is
     *   nonzero), or carries a `filter` / `mask` / `clip-path`; only groups, paths and basic shapes
     *   (`<use>` is already inlined as groups) appear. Shapes that paint nothing (fill and stroke
     *   `none`, `display: none`, hidden, empty geometry) are ignored;
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
        if (contains(region, content.box)) return { clipIds: [content.clipId] };
        const { x, y, width, height } = region;
        if (width <= 0 || height <= 0) return { reason: 'its region is empty' };
        const rect = `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
        return { clipIds: [content.clipId, this.addResolvedClip('svgvd-mask-region', rect)] };
    }

    /** The mask content as a registered clip, or why it is not clip-equivalent. */
    private maskContent(mask: MaskDef, m: Matrix | null): { clipId: string; box: Box } | { reason: string } {
        const alpha = (presentation(mask.el, 'mask-type') ?? '').trim() === 'alpha';
        const pieces: string[] = [];
        const reason = this.flattenMask(mask.el, mask.style, m, alpha, pieces);
        if (reason) return { reason };
        const box = unionBBox(pieces);
        if (!box) return { reason: 'its content is empty (the element is hidden)' };
        return { clipId: this.addResolvedClip('svgvd-mask', pieces.join('')), box };
    }

    /** Flattens clip-equivalent mask content into absolute pathData pieces; returns a reason otherwise. */
    private flattenMask(
        node: XastElement,
        style: Inherited,
        m: Matrix | null,
        alpha: boolean,
        out: string[],
    ): string | null {
        for (const c of node.children ?? []) {
            if (c.type !== 'element' || !c.name || SKIP.has(c.name) || isDisplayNone(c)) continue;
            for (const prop of ['filter', 'mask', 'clip-path'])
                if (!isNone(presentation(c, prop))) return `${prop} inside the mask`;
            const s = resolveStyle(c, style);
            const mm = childMatrix(c, m);
            if (GROUPS.has(c.name)) {
                const reason = this.flattenMask(c, s, mm, alpha, out);
                if (reason) return reason;
                continue;
            }
            if (c.name !== 'path' && !SHAPE_NAMES.has(c.name)) return `<${c.name}> inside the mask`;
            const d = pathDataOf(c, this.viewport, this.precision);
            const fill = s.fill ?? '#000000'; // SVG's initial fill
            const stroked = !isNone(s.stroke) && strokeWidthOf(s) > 0;
            if (!d || isHidden(s) || (isNone(fill) && !stroked)) continue; // paints nothing
            if (stroked) return 'stroked content';
            if (/^url\(/i.test(fill.trim())) return 'gradient or pattern fill';
            const color = toAndroidColor(fill, s.fillOpacity * s.opacityMul, s.color);
            if (!color) return `fill "${fill}" is not a solid color`;
            if (!color.startsWith('#FF')) return 'translucent content';
            if (!alpha && color !== '#FFFFFFFF') return `fill "${fill}" is not white (luminance below 1)`;
            if (s.fillRule === 'evenodd') return 'fill-rule="evenodd" content';
            // Always transformed: the output is absolute, so pieces can be concatenated safely.
            out.push(transformPathData(d, mm ?? IDENTITY));
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
            if (c.type !== 'element' || !c.name || SKIP.has(c.name) || isDisplayNone(c)) continue;
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
            if (c.type !== 'element' || !c.name) continue;
            if (isDisplayNone(c)) continue;
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
            if (childRule !== 'evenodd') {
                out.push(d);
                continue;
            }
            const nonzero = evenOddToNonZero(d, 1);
            if (nonzero === null)
                this.warn({
                    code: 'unsupported-clip-path',
                    message:
                        'clip-rule="evenodd" with crossing or touching contours has no nonzero equivalent in a ' +
                        'VectorDrawable <clip-path>; nonzero is used.',
                    node: 'clipPath',
                });
            out.push(nonzero ?? d);
        }
    }
}

type ClipRule = 'nonzero' | 'evenodd';

/** The element's own `clip-rule`, or the inherited one. */
function clipRuleOf(el: XastElement, inherited: ClipRule): ClipRule {
    const v = presentation(el, 'clip-rule')?.trim();
    return v === 'evenodd' || v === 'nonzero' ? v : inherited;
}
