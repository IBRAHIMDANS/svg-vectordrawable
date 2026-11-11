import type { BBox } from './ast.js';
import { clipPathElement, clipsEverything, wrapClip } from './clip.js';
import type { ConvertContext } from './context.js';
import {
    ANIMATIONS,
    GROUPS,
    isNotRendered,
    pathDataOf,
    switchChild,
    systemLanguageIgnored,
    UNSUPPORTED,
    UNSUPPORTED_ATTRS,
} from './elements.js';
import { escapeXml, formatNumber } from './format.js';
import type { XastElement } from './ast.js';
import { contextGradient, type RawGradient } from './gradient.js';
import { checkGroupOpacity } from './groupOpacity.js';
import { type ContextElement, type ContextServer, isHidden, resolveStyle, type Inherited } from './inherited.js';
import { claimName, renderPath, warnOnce, warnUnresolvedLength } from './paint.js';
import { matrixScale, pathBBox, scaledPrecision, transformPathData } from './pathData.js';
import { isNone, parseStyle, presentation } from './style.js';
import {
    decompose,
    formatMatrix,
    type Decomposed,
    IDENTITY,
    isIdentity,
    isInvalidTransform,
    multiply,
    parseTransform,
    type Matrix,
} from './transform.js';
import { SHAPE_NAMES, unresolvedShapeLengths } from './shapes.js';
import { nestedLayout, unresolvedNestedLengths, type Viewport } from './viewport.js';

/** Nested `<svg>` attributes consumed by its viewport mapping (not inherited by its content). */
const VIEWPORT_ATTRS = new Set(['x', 'y', 'width', 'height', 'viewBox', 'preserveAspectRatio']);

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
    for (const u of unresolvedNestedLengths(el, parentVp))
        warnUnresolvedLength(ctx, u.attr, u.value, 'svg', u.fallback);
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
    if (isInvalidTransform(el.attributes?.transform))
        ctx.warn({
            code: 'unsupported-attribute',
            message: `transform="${el.attributes!.transform}" on <${name}> is not a valid transform list; ignored.`,
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

/** A rendered opacity value: 4 decimals are below what an 8-bit alpha resolves. */
const formatOpacity = (v: number): string => String(Math.round(v * 1e4) / 1e4);

/**
 * Rewrites an element whose mask is clip-equivalent as groups clipped by the mask: the outer one
 * takes over the element's transform, so its clips live in the element's user space (as mask
 * content does); the element itself keeps everything else, its own clip-path included (nested
 * clips intersect).
 */
function maskAsClips(el: XastElement, clipIds: readonly string[], opacity: number): XastElement {
    const { transform, mask: _, style, ...rest } = el.attributes ?? {};
    const declarations = Object.entries(parseStyle(style)).filter(([k]) => k !== 'mask');
    if (declarations.length) rest.style = declarations.map(([k, v]) => `${k}:${v}`).join(';');
    let node: XastElement = { ...el, attributes: rest };
    for (const [i, id] of [...clipIds].reverse().entries()) {
        const outer = i === clipIds.length - 1;
        node = {
            type: 'element',
            name: 'g',
            attributes: {
                ...(outer && transform ? { transform } : {}),
                // A uniform mask value is a group opacity on top of the clips (folded onto the leaves).
                ...(outer && opacity < 1 ? { opacity: formatOpacity(opacity) } : {}),
                'clip-path': `url(#${id})`,
            },
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
    const { child, languageDependent } = switchChild(sw, ctx.foreign);
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

/**
 * True when rendered VectorDrawable XML holds a `<path>` whose stroke paints (a gradient or a
 * non-transparent color, non-zero alpha and width), as `PathBuilder.paints` judges it.
 */
function paintsStroke(xml: string): boolean {
    return xml.split('<path').some((path) => {
        const value = (name: string): string | undefined => new RegExp(`\\sandroid:${name}="([^"]*)"`).exec(path)?.[1];
        const color = value('strokeColor');
        const paint =
            path.includes('<aapt:attr name="android:strokeColor"') || (color !== undefined && !/^#00/.test(color));
        return paint && parseFloat(value('strokeAlpha') ?? '1') > 0 && parseFloat(value('strokeWidth') ?? '1') !== 0;
    });
}

/**
 * Formats a group scale factor. A scale multiplies the whole content, so it keeps at least
 * `max(precision, 1)` significant digits: `scale(0.0001)` would otherwise round to 0 (nothing drawn).
 * Scales of 0.1 and more keep `precision` decimals, as other numbers.
 */
function formatScale(v: number, precision: number): string {
    if (v === 0) return '0';
    const digits = Math.max(precision, 1) - 1 - Math.floor(Math.log10(Math.abs(v)));
    return formatNumber(v, Math.min(Math.max(precision, digits), 20));
}

/**
 * Precision of the content of a group scaled by `dec`. Its coordinates are multiplied by the scale on
 * screen, so they keep `ceil(log10(scale))` more decimals: under `scale(1000)`, `0.0021` stays `0.0021`
 * instead of rounding to `0.002` (2 instead of 2.1 once drawn). Unchanged under a scale of 1 or less.
 */
function scaledContentPrecision(precision: number, dec: Decomposed): number {
    return scaledPrecision(precision, Math.max(Math.abs(dec.scaleX), Math.abs(dec.scaleY)));
}

/** Precision of geometry drawn at `precision` once `bake` (if any) maps it: more under a scale above 1. */
function bakedPrecision(precision: number, bake: Matrix | undefined): number {
    return bake ? scaledPrecision(precision, matrixScale(bake)) : precision;
}

/**
 * Precision of the clips a mask on `el` becomes: they live in its user space (after its own
 * transform, baked or carried by a group, see `maskAsClips`), drawn like its content.
 */
function maskPrecision(ctx: ConvertContext, el: XastElement, bake: Matrix | undefined): number {
    const own = parseTransform(el.attributes?.transform);
    return bakedPrecision(ctx.precision, own ? multiply(bake ?? IDENTITY, own) : bake);
}

/** Android `<group>` transform attributes of a decomposed matrix (identity parts omitted). */
function groupTransformAttrs(ctx: ConvertContext, dec: Decomposed, pad: string): string[] {
    const parts: [string, number, number, typeof formatNumber][] = [
        ['translateX', dec.translateX, 0, formatNumber],
        ['translateY', dec.translateY, 0, formatNumber],
        ['rotation', dec.rotation, 0, formatNumber],
        ['scaleX', dec.scaleX, 1, formatScale],
        ['scaleY', dec.scaleY, 1, formatScale],
    ];
    return parts
        .filter(([, v, neutral]) => Math.abs(v - neutral) > 1e-6)
        .map(([name, v, , format]) => `${pad}${ctx.step}android:${name}="${format(v, ctx.precision)}"`);
}

/**
 * Records what rendering content adds to `ctx` (gradient use, names claimed under `preserveIds`)
 * and returns how to undo it, for content a clip then drops: no unused `xmlns:aapt`, and the names
 * stay free for the elements actually drawn.
 */
function checkpoint(ctx: ConvertContext): () => void {
    const usedGradient = ctx.usesGradient;
    // Names are only added meanwhile (a group frees only the name it just claimed): the ones claimed
    // since come last, in insertion order.
    const claimed = ctx.names?.size ?? 0;
    return () => {
        ctx.usesGradient = usedGradient;
        if (ctx.names) for (const name of [...ctx.names].slice(claimed)) ctx.names.delete(name);
    };
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
    // A sheared transform (or any transform nested under a baked one) can't be an
    // Android <group>; bake the matrix into descendant geometry instead.
    const asGroup = !!(matrix && dec && !bake && !dec.hasSkew);
    const precision = asGroup ? scaledContentPrecision(ctx.precision, dec!) : ctx.precision;
    // The matrix baked into the content: none under a group that carries the transform.
    const nextBake = asGroup ? undefined : matrix ? multiply(bake ?? IDENTITY, matrix) : bake;
    // clipPathUnits="userSpaceOnUse" lives in the group's own user space (after its transform), drawn
    // at the precision of the group's content, or more when a matrix with a large scale is baked into it.
    const clipD = ctx.clips.resolve(el, style, bakedPrecision(precision, nextBake));
    // Baking is exact for fills; only a stroke (width scaled uniformly, not sheared) is approximated.
    const reportSkew = (inner: string): void => {
        if (dec?.hasSkew && !bake && paintsStroke(inner))
            ctx.warn({
                code: 'group-skew',
                message: 'A <g> uses skew/shear; baking the transform into path geometry.',
                node: 'g',
            });
    };
    const rollback = checkpoint(ctx);
    // Claimed before the content, so that the group wins over a descendant with the same id.
    const name = claimName(ctx, el);
    if (asGroup || name !== undefined) {
        // A named group stays a <group> (preserveIds); a matrix it cannot carry is baked into its content.
        const innerCtx = precision === ctx.precision ? ctx : { ...ctx, precision };
        const inner = walk(innerCtx, el, style, pad + step, nextBake);
        ctx.usesGradient = innerCtx.usesGradient; // the scoped copy, if any, holds the flag
        reportSkew(inner);
        const clip = clipD && nextBake ? transformPathData(clipD, nextBake) : clipD;
        // Nothing drawn (empty content, or a clip that clips everything, as in wrapClip): no group.
        if (!inner.trim() || (clip && clipsEverything(clip))) {
            rollback();
            return null;
        }
        const attrs = [
            ...(name === undefined ? [] : [`${pad}${step}android:name="${escapeXml(name)}"`]),
            ...(asGroup ? groupTransformAttrs(ctx, dec!, pad) : []),
        ];
        const head = attrs.length ? `${pad}<group\n${attrs.join('\n')}>` : `${pad}<group>`;
        const clipLine = clip ? `${clipPathElement(clip, pad + step)}\n` : '';
        return `${head}\n${clipLine}${inner}\n${pad}</group>`;
    }
    const inner = walk(ctx, el, style, pad, nextBake);
    reportSkew(inner);
    if (!inner.trim()) return null;
    if (!clipD) return inner;
    const wrapped = wrapClip(nextBake ? transformPathData(clipD, nextBake) : clipD, inner, pad, step);
    if (!wrapped) rollback(); // a clip that clips everything
    return wrapped;
}

/** Corners of a bounding box being accumulated. */
type Extent = { x0: number; y0: number; x1: number; y1: number };

/**
 * Adds to `extent` the geometry of the children of `el`, their user space mapped by `m`. false when
 * the content holds what it cannot measure (nested `<svg>`, `<switch>`, unresolved `<use>`, text,
 * images).
 */
function measureContent(ctx: ConvertContext, el: XastElement, m: Matrix, viewport: Viewport, extent: Extent): boolean {
    const { foreign } = ctx;
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
 * laid out (see `contextGradient`), becomes the keyword again, which paint.ts reports. Any other
 * reference (unknown or invalid gradient, or one without stops) is left to paint.ts, whose handling
 * does not depend on the space and whose warnings then name the author's id.
 */
function contextPaints(ctx: ConvertContext, style: Inherited): { ctx: ConvertContext; style: Inherited } {
    let gradients: Map<string, RawGradient> | undefined;
    let next = style;
    for (const prop of ['fill', 'stroke'] as const) {
        const server: ContextServer | undefined = prop === 'fill' ? style.fillServer : style.strokeServer;
        const ref = server && URL_ID.exec(style[prop]?.trim() ?? '')?.[1];
        if (!server || ref === undefined) continue;
        const raw = ctx.gradients.get(ref);
        // A gradient without stops paints none wherever it is laid out.
        if (raw?.stops.length === 0 || (!raw && !ctx.patternIds.has(ref))) continue;
        const { context } = server;
        const mapped = raw
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
    // Once per name, as walk reports it (same message): <set> in a <g> and in a <rect> is one warning.
    const { foreign } = ctx;
    for (const child of el.children ?? [])
        if (child.type === 'element' && ANIMATIONS.has(child.name ?? '') && !isNotRendered(child, foreign))
            warnOnce(ctx, {
                code: 'unsupported-element',
                message: `<${child.name}> cannot be represented in a VectorDrawable; skipped.`,
                node: child.name!,
            });
    if (SHAPE_NAMES.has(name) && !isHidden(style))
        for (const u of unresolvedShapeLengths(name, el.attributes ?? {}, style.viewport))
            warnUnresolvedLength(ctx, u.attr, u.value, name, u.fallback);
    const d = pathDataOf(el, style.viewport, ctx.precision);
    if (d) {
        if (isHidden(style)) return null;
        const rollback = checkpoint(ctx);
        const painted = contextPaints(ctx, style);
        const body = renderPath(painted.ctx, d, el, painted.style, pad, bake);
        ctx.usesGradient = painted.ctx.usesGradient; // the scoped copy, if any, holds the flag
        // painted.style: a context-stroke resolved from the <use> decides the stroke-box too.
        // Reports an unusable clip even when unpainted.
        const clipD = ctx.clips.resolve(el, painted.style, bakedPrecision(ctx.precision, bake));
        if (!body) return null; // paints nothing: no clip wrapper either
        const clip = clipD && bake ? transformPathData(clipD, bake) : clipD;
        if (!clip) return body;
        const wrapped = wrapClip(clip, body, pad, ctx.step);
        if (!wrapped) rollback(); // a clip that clips everything
        return wrapped;
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
 * Renders a `<text>` as the `<path>` of its glyph outlines (`ctx.text`, the `fonts` option), painted
 * like a shape. Glyph outlines are filled nonzero, whatever `fill-rule` says (as browsers draw
 * text). Text it cannot lay out is reported (once per reason) and skipped, as without the option.
 */
function renderText(
    ctx: ConvertContext,
    el: XastElement,
    style: Inherited,
    pad: string,
    bake: Matrix | undefined,
): string | null {
    const layout = ctx.text!(el, style);
    if ('reason' in layout) {
        // Once per reason: every <text> in an unsupported font would otherwise repeat it.
        warnOnce(ctx, {
            code: 'unsupported-element',
            message: `<text> cannot be represented in a VectorDrawable (${layout.reason}); skipped.`,
            node: 'text',
        });
        return null;
    }
    if (!layout.d) return null; // no glyph to draw (whitespace only, font-size 0)
    const path: XastElement = { type: 'element', name: 'path', attributes: { ...el.attributes, d: layout.d } };
    return renderLeaf(ctx, path, 'path', { ...style, fillRule: 'nonzero' }, pad, bake);
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
    const { foreign } = ctx;
    for (const child of el.children ?? []) {
        if (child.type !== 'element' || !child.name) continue;
        const name = child.name;
        if (isNotRendered(child, foreign)) continue; // nor its subtree
        // With the fonts option, a <text> is drawn as glyph outlines (renderText), or reported there.
        if (UNSUPPORTED.has(name) && !(name === 'text' && ctx.text)) {
            // Once per element name: a document full of labels (or images, animations) would otherwise
            // repeat it per element. Strict still rejects the same files: the first one is reported.
            warnOnce(ctx, {
                code: 'unsupported-element',
                message: `<${name}> cannot be represented in a VectorDrawable; skipped.`,
                node: name,
            });
            continue;
        }

        // A mask made of opaque shapes is a clip in disguise: render it as one.
        let maskReason: string | undefined;
        if (name !== 'svg' && !ctx.reported.has(child) && !isNone(presentation(child, 'mask'))) {
            const mask = ctx.clips.resolveMask(child, parent.viewport, maskPrecision(ctx, child, bake));
            if ('clipIds' in mask) {
                push(walk(ctx, fragment(maskAsClips(child, mask.clipIds, mask.opacity)), parent, pad, bake));
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
            ctx.reported.add(wrapper); // its transform was reported on `child`
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
        else if (name === 'text') push(renderText(ctx, child, style, pad, bake));
        else push(renderLeaf(ctx, child, name, style, pad, bake));
    }
    return out.join('\n');
}
