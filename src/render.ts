import { clipPathElement, wrapClip } from './clip.js';
import type { ConvertContext } from './context.js';
import { GROUPS, isDisplayNone, pathDataOf, SKIP, UNSUPPORTED, UNSUPPORTED_ATTRS } from './elements.js';
import { formatNumber } from './format.js';
import type { XastElement } from './gradient.js';
import { checkGroupOpacity } from './groupOpacity.js';
import { isHidden, resolveStyle, type Inherited } from './inherited.js';
import { renderPath } from './paint.js';
import { transformPathData } from './pathData.js';
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
import { nestedLayout, type Viewport } from './viewport.js';

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
 * Renders a `<g>` / `<a>`: as an Android `<group>` when its transform decomposes, otherwise by
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
    const clipD = ctx.clips.resolve(el.attributes ?? {});
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

/** Renders a drawable leaf (`<path>` or basic shape), or reports why it draws nothing. */
function renderLeaf(
    ctx: ConvertContext,
    el: XastElement,
    name: string,
    style: Inherited,
    pad: string,
    bake: Matrix | undefined,
): string | null {
    const d = pathDataOf(el, style.viewport, ctx.precision);
    if (d) {
        if (isHidden(style)) return null;
        const body = renderPath(ctx, d, el, style, pad, bake);
        const clipD = ctx.clips.resolve(el.attributes ?? {}); // reports an unusable clip even when unpainted
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
    for (const child of el.children ?? []) {
        if (child.type !== 'element' || !child.name) continue;
        const name = child.name;
        if (SKIP.has(name)) continue;
        if (UNSUPPORTED.has(name)) {
            ctx.warn({
                code: 'unsupported-element',
                message: `<${name}> cannot be represented in a VectorDrawable; skipped.`,
                node: name,
            });
            continue;
        }
        if (isDisplayNone(child)) continue; // not rendered, nor its subtree

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
        if (!GROUPS.has(name) && transform) {
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
        push(
            GROUPS.has(name)
                ? renderGroup(ctx, child, parent, style, pad, bake)
                : renderLeaf(ctx, child, name, style, pad, bake),
        );
    }
    return out.join('\n');
}
