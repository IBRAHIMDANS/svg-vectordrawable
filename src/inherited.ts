import type { XastElement } from './ast.js';
import { parseStyle } from './style.js';
import { parseLength, parseOpacity } from './units.js';
import { diagonal, type Viewport } from './viewport.js';

/** Computed style flowing down the tree (inherited properties plus the accumulated opacity). */
export interface Inherited {
    fill?: string;
    fillOpacity: number;
    fillRule?: string;
    stroke?: string;
    strokeOpacity: number;
    strokeWidth?: string;
    strokeLinecap?: string;
    strokeLinejoin?: string;
    strokeMiterlimit?: string;
    strokeDasharray?: string;
    strokeDashoffset?: string;
    paintOrder?: string;
    visibility?: string;
    color: string;
    opacityMul: number;
    /** Size of the nearest viewport (viewBox units): the reference for percentage lengths. */
    viewport: Viewport;
    /**
     * Paints of the context element (SVG 2 §13.3: the nearest `<use>` instancing this content),
     * read by `context-fill` / `context-stroke`; undefined outside a `<use>` instance. A paint left
     * undefined is the initial one (black fill, no stroke), like an unset `fill` / `stroke`.
     */
    context?: { fill?: string; stroke?: string };
}

/**
 * Marks the `<g>` that replaces an expanded `<use>` (see useResolver.ts): it is the context element
 * of its content. Not an SVG attribute, so nothing else reads it.
 */
export const USE_INSTANCE_ATTR = 'data-svgvd-use-instance';

const CONTEXT_PAINT = /^context-(fill|stroke)$/i;
const URL_PAINT = /^url\(/i;

/**
 * `fill` / `stroke` value with `context-fill` / `context-stroke` replaced by the context element's
 * paint (undefined: its initial paint). Kept as the keyword, which paint.ts reports, when there is no
 * context element or when that paint is a paint server: SVG 2 lays it out over the context
 * element's bounding box and user space, not the shape's, which the converter does not track.
 */
function contextResolved(value: string, context: Inherited['context']): string | undefined {
    const which = CONTEXT_PAINT.exec(value.trim())?.[1]?.toLowerCase();
    if (which === undefined || context === undefined) return value;
    const paint = which === 'fill' ? context.fill : context.stroke;
    return paint !== undefined && URL_PAINT.test(paint.trim()) ? value : paint;
}

const INHERITABLE = [
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-opacity',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'stroke-dasharray',
    'stroke-dashoffset',
    'paint-order',
    'visibility',
    'color',
] as const;

/** Initial style of the document: SVG defaults, `currentColor` resolved to `color`. */
export const initialStyle = (color: string, viewport: Viewport): Inherited => ({
    fillOpacity: 1,
    strokeOpacity: 1,
    color,
    opacityMul: 1,
    viewport,
});

/** Computes an element's style from its parent's (inline `style` wins over attributes). */
export function resolveStyle(el: XastElement, parent: Inherited): Inherited {
    const attrs = el.attributes ?? {};
    const style = parseStyle(attrs.style);
    const get = (name: string): string | undefined => style[name] ?? attrs[name];
    const next: Inherited = { ...parent };
    for (const prop of INHERITABLE) {
        const v = get(prop);
        // `inherit` keeps the parent's computed value, which `next` already holds.
        if (v === undefined || v.trim() === 'inherit') continue;
        if (prop === 'fill') next.fill = contextResolved(v, parent.context);
        else if (prop === 'fill-opacity') next.fillOpacity = parseOpacity(v);
        else if (prop === 'fill-rule') next.fillRule = v;
        else if (prop === 'stroke') next.stroke = contextResolved(v, parent.context);
        else if (prop === 'stroke-opacity') next.strokeOpacity = parseOpacity(v);
        else if (prop === 'stroke-width') next.strokeWidth = v;
        else if (prop === 'stroke-linecap') next.strokeLinecap = v;
        else if (prop === 'stroke-linejoin') next.strokeLinejoin = v;
        else if (prop === 'stroke-miterlimit') next.strokeMiterlimit = v;
        else if (prop === 'stroke-dasharray') next.strokeDasharray = v;
        else if (prop === 'stroke-dashoffset') next.strokeDashoffset = v;
        else if (prop === 'paint-order') next.paintOrder = v;
        else if (prop === 'visibility') next.visibility = v.trim();
        else if (prop === 'color') next.color = v;
    }
    next.opacityMul = parent.opacityMul * parseOpacity(get('opacity'));
    // The use's own paints (attributes, else inherited) are its content's context paints.
    if (attrs[USE_INSTANCE_ATTR] !== undefined) next.context = { fill: next.fill, stroke: next.stroke };
    return next;
}

export const isHidden = (style: Inherited): boolean => style.visibility === 'hidden' || style.visibility === 'collapse';

/** Fill paint, with SVG's implicit black (or `none`) when no fill is set. */
export const fillOf = (style: Inherited, fillBlackForUnfilled: boolean): string =>
    style.fill ?? (fillBlackForUnfilled ? '#000000' : 'none');

/** Stroke width in user units; a percentage is relative to the viewport's normalized diagonal. */
export function strokeWidthOf(style: Inherited): number {
    const w = parseLength(style.strokeWidth ?? '1', diagonal(style.viewport));
    return Number.isNaN(w) ? 1 : w;
}
