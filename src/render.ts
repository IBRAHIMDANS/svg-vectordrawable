import type { BBox } from './ast.js';
import { clipPathElement, wrapClip } from './clip.js';
import type { ConvertContext } from './context.js';
import {
    ANIMATIONS,
    foreignElements,
    GROUPS,
    isNotRendered,
    pathDataOf,
    switchChild,
    UNSUPPORTED,
    UNSUPPORTED_ATTRS,
} from './elements.js';
import { formatNumber } from './format.js';
import type { XastElement } from './ast.js';
import { contextGradient, type RawGradient } from './gradient.js';
import { checkGroupOpacity } from './groupOpacity.js';
import { type ContextElement, type ContextServer, isHidden, resolveStyle, type Inherited } from './inherited.js';
import { renderPath } from './paint.js';
import { pathBBox, transformPathData } from './pathData.js';
import { isNone, parseStyle, presentation } from './style.js';
import {
    decompose,
    formatMatrix,
    type Decomposed,
    IDENTITY,
    isIdentity,
    multiply,
    parseTransform,
    type Matrix,
} from './transform.js';
import { SHAPE_NAMES } from './shapes.js';
import { nestedLayout, type Viewport } from './viewport.js';

/** Nested `<svg>` attributes consumed by its viewport mapping (not inherited by its content). */
const VIEWPORT_ATTRS = new Set(['x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio']);

/**
 * Elements outside the SVG namespace, per conversion: computed on the first `walk` of a context,
 * which receives the root `<svg>` (namespace scoping needs the whole tree). Synthetic copies made
 * while walking are copies of SVG elements; their children are the original, classified, nodes.
 */
const foreignByContext = new WeakMap<ConvertContext, WeakSet<XastElement>>();

function foreignOf(ctx: ConvertContext, root: XastElement): WeakSet<XastElement> {
    let foreign = foreignByContext.get(ctx);
    if (!foreign) foreignByContext.set(ctx, (foreign = foreignElements(root)));
    return foreign;
}

/** A synthetic container holding `children`, walked like an element's content. */
const fragment = (...children: XastElement[]): XastElement => ({ type: 'element', children });

/**
 * Rewrites a nested `<svg>` as plain groups: the outer one keeps its presentation attributes,
 * the middle one clips to its viewport rectangle (unless `overflow` is visible) and the inner
 * one maps its viewBox onto that viewport. Returns null for an empty viewport (not rendered).
 */
function nestedSvg(
    ctx: ConvertContext,
    el: XastElement,
    parentVp: Viewport,
): { group: XastElement; viewport: Viewport } | null {
    const layout = nestedLayout(el, parentVp);
    if (!layout) return null;
    const { x, y, width, height, matrix: m } = layout;
    const rest = Object.fromEntries(Object.entries(el.attributes ?? {}).filter(([k]) => !VIEWPORT_ATTRS.has(k)));
    const content: XastElement = {
        type: 'element',
        name: 'g',
        attributes: isIdentity(m) ? {} : { transform: formatMatrix(m) },
        children: el.children ?? [],
    };

    let clipped = content;
    if (layout.clipped) {
        const id = ctx.clips.addViewportClip(x, y, width, height);
        clipped = { type: 'element', name: 'g', attributes: { 'clip-path': `url(#${id})` }, children: [content] };
    }
    const group: XastElement = { type: 'element', name: 'g', attributes: rest, children: [clipped] };
    // Unsupported attributes (attribute or style declaration) were already reported on the <svg>.
    ctx.reported.add(group);
    return { group, viewport: layout.viewport };
}

/** Warning message for a non-empty `systemLanguage` on `<name>` (the root `<svg>` included). */
export const systemLanguageIgnored = (name: string): string =>
    `systemLanguage on <${name}> depends on the device language, which a VectorDrawable cannot test; ignored.`;

/**
 * Reports the unsupported presentation attributes of an element (once per source element).
 * `maskReason` says why its mask is not clip-equivalent (see `ClipPaths.resolveMask`).
 */
function reportUnsupportedAttrs(ctx: ConvertContext, el: XastElement, name: string, maskReason?: string): void {
    if (ctx.reported.has(el)) return;
    // An empty systemLanguage is never rendered (see failsConditions); any other value depends on the device.
    if (el.attributes?.systemLanguage !== undefined)
        ctx.warn({
            code: 'unsupported-attribute',
            message: systemLanguageIgnored(name),
            node: name,
        });
    for (const attr of UNSUPPORTED_ATTRS) {
        if (!isNone(presentation(el, attr))) {
            const why = attr === 'mask' && maskReason ? ` (${maskReason})` : '';
            ctx.warn({
                code: 'unsupported-attribute',
                message: `${attr} on <${name}> cannot be represented in a VectorDrawable${why}; ignored.`,
                node: name,
            });
        }
    }
}

/**
 * Rewrites an element whose mask is clip-equivalent as groups clipped by the mask: the outer one
 * takes over the element's transform, so its clips live in the element's user space (as mask
 * content does); the element itself keeps everything else, its own clip-path included (nested
 * clips intersect).
 */
function maskAsClips(el: XastElement, clipIds: readonly string[]): XastElement {
    const { transform, mask: _, style, ...rest } = el.attributes ?? {};
    const declarations = Object.entries(parseStyle(style)).filter(([k]) => k !== 'mask');
    if (declarations.length) rest.style = declarations.map(([k, v]) => `${k}:${v}`).join(';');
    let node: XastElement = { ...el, attributes: rest };
    for (const [i, id] of [...clipIds].reverse().entries()) {
        const outer = i === clipIds.length - 1;
        node = {
            type: 'element',
            name: 'g',
            attributes: { ...(outer && transform ? { transform } : {}), 'clip-path': `url(#${id})` },
            children: [node],
        };
    }
    return node;
}

/**
 * A `<switch>` as the group it renders: its own attributes (transform, clip-path, opacity…) around
 * the one child `switchChild` picks, if any. A pick depending on the device language is reported
 * here, once, so the picked child's `systemLanguage` is dropped (not reported again).
 */
function switchAsGroup(ctx: ConvertContext, sw: XastElement): XastElement {
    const { child, languageDependent } = switchChild(sw, foreignOf(ctx, sw));
    if (languageDependent) {
        const picked = child?.attributes?.systemLanguage === undefined ? 'the child without it' : 'the first child';
        ctx.warn({
            code: 'unsupported-attribute',
            message: `systemLanguage on the children of <switch> depends on the device language, which a VectorDrawable cannot test; ${picked} is rendered.`,
            node: 'switch',
        });
    }
    if (!child) return { ...sw, children: [] };
    const { systemLanguage: _, ...attributes } = child.attributes ?? {};
    return { ...sw, children: [{ ...child, attributes }] };
}

/** Android `<group>` transform attributes of a decomposed matrix (identity parts omitted). */
function groupTransformAttrs(ctx: ConvertContext, dec: Decomposed, pad: string): string[] {
    const parts: [string, number, number][] = [
        ['translateX', dec.translateX, 0],
        ['translateY', dec.translateY, 0],
        ['rotation', dec.rotation, 0],
        ['scaleX', dec.scaleX, 1],
        ['scaleY', dec.scaleY, 1],
    ];
    return parts
        .filter(([, v, neutral]) => Math.abs(v - neutral) > 1e-6)
        .map(([name, v]) => `${pad}${ctx.step}android:${name}="${formatNumber(v, ctx.precision)}"`);
}

/**
 * Renders a `<g>` / `<a>` (or a `<switch>`, see `switchAsGroup`): as an Android `<group>` when its transform decomposes, otherwise by
 * baking the transform into descendant geometry.
 */
function renderGroup(
    ctx: ConvertContext,
    el: XastElement,
    parent: Inherited,
    style: Inherited,
    pad: string,
    bake: Matrix | undefined,
): string | null {
    const { step } = ctx;
    checkGroupOpacity(ctx, el, parent);
    const matrix = parseTransform(el.attributes?.transform);
    const dec = matrix ? decompose(matrix) : null;
    // clipPathUnits="userSpaceOnUse" lives in the group's own user space (after its transform).
    const clipD = ctx.clips.resolve(el, style);
    // A sheared transform (or any transform nested under a baked one) can't be an
    // Android <group>; bake the matrix into descendant geometry instead.
    if (matrix && dec && !bake && !dec.hasSkew) {
        const inner = walk(ctx, el, style, pad + step);
        if (!inner.trim()) return null;
        const attrs = groupTransformAttrs(ctx, dec, pad);
        const head = attrs.length ? `${pad}<group\n${attrs.join('\n')}>` : `${pad}<group>`;
        const clipLine = clipD ? `${clipPathElement(clipD, pad + step)}\n` : '';
        return `${head}\n${clipLine}${inner}\n${pad}</group>`;
    }
    if (dec?.hasSkew && !bake)
        ctx.warn({
            code: 'group-skew',
            message: 'A <g> uses skew/shear; baking the transform into path geometry.',
            node: 'g',
        });
    const nextBake = matrix ? multiply(bake ?? IDENTITY, matrix) : bake;
    const inner = walk(ctx, el, style, pad, nextBake);
    if (!inner.trim()) return null;
    return clipD ? wrapClip(nextBake ? transformPathData(clipD, nextBake) : clipD, inner, pad, step) : inner;
}

/** Corners of a bounding box being accumulated. */
type Extent = { x0: number; y0: number; x1: number; y1: number };

/**
 * Adds to `extent` the geometry of the children of `el`, their user space mapped by `m`. false when
 * the content holds what it cannot measure (nested `<svg>`, `<switch>`, unresolved `<use>`, text,
 * images).
 */
function measureContent(ctx: ConvertContext, el: XastElement, m: Matrix, viewport: Viewport, extent: Extent): boolean {
    const foreign = foreignOf(ctx, el);
    for (const child of el.children ?? []) {
        if (child.type !== 'element' || isNotRendered(child, foreign)) continue;
        const name = child.name!;
        const own = parseTransform(child.attributes?.transform);
        const cm = own ? multiply(m, own) : m;
        if (GROUPS.has(name)) {
            if (!measureContent(ctx, child, cm, viewport, extent)) return false;
            continue;
        }
        if (name !== 'path' && !SHAPE_NAMES.has(name)) return false;
        const d = pathDataOf(child, viewport, ctx.precision);
        const b = d ? pathBBox(transformPathData(d, cm)) : null;
        if (!b) continue; // no geometry: no part of the box
        extent.x0 = Math.min(extent.x0, b.x);
        extent.y0 = Math.min(extent.y0, b.y);
        extent.x1 = Math.max(extent.x1, b.x + b.width);
        extent.y1 = Math.max(extent.y1, b.y + b.height);
    }
    return true;
}

/**
 * Bounding box of the children of `el` in its user space (SVG 2 §8.10: geometry only, clipping and
 * visibility ignored, elements not rendered left out). Null when empty or not measurable.
 */
function contentBBox(ctx: ConvertContext, el: XastElement, viewport: Viewport): BBox | null {
    const extent: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    if (!measureContent(ctx, el, IDENTITY, viewport, extent) || extent.x0 > extent.x1) return null;
    return { x: extent.x0, y: extent.y0, width: extent.x1 - extent.x0, height: extent.y1 - extent.y0 };
}

/** Bounding boxes of context elements, computed on first use. */
const contextBoxes = new WeakMap<ContextElement, BBox | null>();

function contextBBox(ctx: ConvertContext, context: ContextElement): BBox | null {
    if (!contextBoxes.has(context)) contextBoxes.set(context, contentBBox(ctx, context.element, context.viewport));
    return contextBoxes.get(context) ?? null;
}

const URL_ID = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/i;

/**
 * Lays out the paint servers `style` takes from a context element (`context-fill` /
 * `context-stroke` naming a gradient) over that element, as synthetic `userSpaceOnUse` gradients
 * of the shape, looked up through a scoped copy of `ctx`. A pattern, or a gradient that cannot be
 * laid out (see `contextGradient`; `userSpaceOnUse` needs the use's user space, see
 * `ContextElement.userSpace`), becomes the keyword again, which paint.ts reports. Any other
 * reference (unknown or invalid gradient) is left to paint.ts, whose handling does not depend on
 * the space.
 */
function contextPaints(ctx: ConvertContext, style: Inherited): { ctx: ConvertContext; style: Inherited } {
    let gradients: Map<string, RawGradient> | undefined;
    let next = style;
    for (const prop of ['fill', 'stroke'] as const) {
        const server: ContextServer | undefined = prop === 'fill' ? style.fillServer : style.strokeServer;
        const ref = server && URL_ID.exec(style[prop]?.trim() ?? '')?.[1];
        if (!server || ref === undefined) continue;
        const raw = ctx.gradients.get(ref);
        if (!raw && !ctx.patternIds.has(ref)) continue;
        const { context } = server;
        const mapped =
            raw && (raw.objectBox || context.userSpace)
                ? contextGradient(
                      raw,
                      context.ctm,
                      style.ctm ?? IDENTITY,
                      raw.objectBox ? contextBBox(ctx, context) : null,
                      context.viewport,
                  )
                : null;
        if (!mapped) {
            next = { ...next, [prop]: server.keyword };
            continue;
        }
        let id = `svgvd-context-${prop}`;
        while (ctx.gradientIds.has(id) || ctx.patternIds.has(id)) id += '_';
        gradients ??= new Map(ctx.gradients);
        gradients.set(id, mapped);
        next = { ...next, [prop]: `url(#${id})` };
    }
    return { ctx: gradients ? { ...ctx, gradients } : ctx, style: next };
}

/** Renders a drawable leaf (`<path>` or basic shape), or reports why it draws nothing. */
function renderLeaf(
    ctx: ConvertContext,
    el: XastElement,
    name: string,
    style: Inherited,
    pad: string,
    bake: Matrix | undefined,
): string | null {
    // A leaf's children are never walked: an animation of the leaf would otherwise vanish silently.
    const foreign = foreignOf(ctx, el);
    for (const child of el.children ?? [])
        if (child.type === 'element' && ANIMATIONS.has(child.name ?? '') && !isNotRendered(child, foreign))
            ctx.warn({
                code: 'unsupported-element',
                message: `<${child.name}> cannot be represented in a VectorDrawable; skipped.`,
                node: child.name!,
            });
    const d = pathDataOf(el, style.viewport, ctx.precision);
    if (d) {
        if (isHidden(style)) return null;
        const painted = contextPaints(ctx, style);
        const body = renderPath(painted.ctx, d, el, painted.style, pad, bake);
        ctx.usesGradient = painted.ctx.usesGradient; // the scoped copy, if any, holds the flag
        // painted.style: a context-stroke resolved from the <use> decides the stroke-box too.
        const clipD = ctx.clips.resolve(el, painted.style); // reports an unusable clip even when unpainted
        if (!body) return null; // paints nothing: no clip wrapper either
        const clip = clipD && bake ? transformPathData(clipD, bake) : clipD;
        return clip ? wrapClip(clip, body, pad, ctx.step) : body;
    }
    if (name !== 'use')
        ctx.warn({ code: 'empty-path', message: `<${name}> produced no drawable geometry; skipped.`, node: name });
    else
        ctx.warn({
            code: 'unsupported-element',
            message: '<use> references are not resolved; skipped.',
            node: 'use',
        });
    return null;
}

/**
 * Renders the children of `el` as VectorDrawable XML at indentation `pad`. `bake` is the
 * transform (from skewed ancestors) baked into descendant geometry instead of a `<group>`.
 */
export function walk(ctx: ConvertContext, el: XastElement, parent: Inherited, pad: string, bake?: Matrix): string {
    const out: string[] = [];
    const push = (xml: string | null): void => {
        if (xml?.trim()) out.push(xml);
    };
    const foreign = foreignOf(ctx, el);
    for (const child of el.children ?? []) {
        if (child.type !== 'element' || !child.name) continue;
        const name = child.name;
        if (isNotRendered(child, foreign)) continue; // nor its subtree
        if (UNSUPPORTED.has(name)) {
            ctx.warn({
                code: 'unsupported-element',
                message: `<${name}> cannot be represented in a VectorDrawable; skipped.`,
                node: name,
            });
            continue;
        }

        // A mask made of opaque shapes is a clip in disguise: render it as one.
        let maskReason: string | undefined;
        if (name !== 'svg' && !ctx.reported.has(child) && !isNone(presentation(child, 'mask'))) {
            const mask = ctx.clips.resolveMask(child, parent.viewport);
            if ('clipIds' in mask) {
                push(walk(ctx, fragment(maskAsClips(child, mask.clipIds)), parent, pad, bake));
                continue;
            }
            maskReason = mask.reason;
        }
        reportUnsupportedAttrs(ctx, child, name, maskReason);

        // A transform on a drawable element behaves like a wrapping <g transform>: reuse that path.
        const transform = child.attributes?.transform;
        if (!GROUPS.has(name) && name !== 'switch' && transform) {
            const { transform: _, ...rest } = child.attributes!;
            const untransformed: XastElement = { ...child, attributes: rest };
            ctx.reported.add(untransformed); // its unsupported attributes were just reported
            const wrapper: XastElement = {
                type: 'element',
                name: 'g',
                attributes: { transform },
                children: [untransformed],
            };
            push(walk(ctx, fragment(wrapper), parent, pad, bake));
            continue;
        }

        if (name === 'svg') {
            const nested = nestedSvg(ctx, child, parent.viewport);
            if (nested) push(walk(ctx, fragment(nested.group), { ...parent, viewport: nested.viewport }, pad, bake));
            continue;
        }

        const style = resolveStyle(child, parent);
        if (name === 'switch') push(renderGroup(ctx, switchAsGroup(ctx, child), parent, style, pad, bake));
        else if (GROUPS.has(name)) push(renderGroup(ctx, child, parent, style, pad, bake));
        else push(renderLeaf(ctx, child, name, style, pad, bake));
    }
    return out.join('\n');
}
