import type { XastElement } from './ast.js';
import { toAndroidColor } from './color.js';
import { parseStyle } from './style.js';
import { IDENTITY, multiply, parseTransform, type Matrix } from './transform.js';
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
     * The context element (SVG 2 §13.3: the nearest `<use>` instancing this content), read by
     * `context-fill` / `context-stroke`; undefined outside a `<use>` instance.
     */
    context?: ContextElement;
    /** Transform from this element's user space (inside its own `transform`) to the root's; identity when unset. */
    ctm?: Matrix;
    /** Set when `fill` is a paint server taken from a context element: it is laid out over that element. */
    fillServer?: ContextServer;
    /** Set when `stroke` is a paint server taken from a context element (see `fillServer`). */
    strokeServer?: ContextServer;
    /**
     * The `fill` declaration ignored as invalid (trimmed) on the way to the computed `fill`: on this
     * element, or on an ancestor whose value it inherits. paint.ts reports it; undefined once an
     * element declares a valid `fill`.
     */
    fillInvalid?: string;
    /** The ignored `stroke` declaration (see `fillInvalid`). */
    strokeInvalid?: string;
}

/** A `<use>` instance as the context element of its content. */
export interface ContextElement {
    /** Its paints; undefined is the initial one (black fill, no stroke), like an unset `fill` / `stroke`. */
    fill?: string;
    stroke?: string;
    /**
     * true when that paint is itself a paint server taken from an outer context element: whose
     * coordinate space lays it out is then ambiguous, so `context-fill` / `context-stroke` stay unresolved.
     */
    fillNested: boolean;
    strokeNested: boolean;
    /** The instance `<g>`: its children are the content whose bounding box `objectBoundingBox` uses. */
    element: XastElement;
    /** `ctm` of the content (inside the instance's transform). */
    ctm: Matrix;
    viewport: Viewport;
    /**
     * true when the content's user space is the use's own (no transform on the instance): the
     * instance's transform merges the use's `transform` with its x/y offset, which then cannot be
     * told apart, while `userSpaceOnUse` lives in the use's space, before the offset.
     */
    userSpace: boolean;
}

/** A paint server taken from a context element by `keyword` (`context-fill` / `context-stroke`). */
export interface ContextServer {
    keyword: string;
    context: ContextElement;
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
 * paint (undefined: its initial paint). A paint server comes with its context element (`server`):
 * SVG 2 lays it out over that element's bounding box and user space, not the shape's (render.ts
 * maps it). Kept as the keyword, which paint.ts reports, when there is no context element or when
 * that paint server itself comes from an outer context element.
 */
function contextResolved(
    value: string,
    context: ContextElement | undefined,
): { paint: string | undefined; server?: ContextServer } {
    const keyword = value.trim();
    const which = CONTEXT_PAINT.exec(keyword)?.[1]?.toLowerCase();
    if (which === undefined || context === undefined) return { paint: value };
    const paint = which === 'fill' ? context.fill : context.stroke;
    if (paint === undefined || !URL_PAINT.test(paint.trim())) return { paint };
    const nested = which === 'fill' ? context.fillNested : context.strokeNested;
    return nested ? { paint: value } : { paint, server: { keyword, context } };
}

/**
 * true when a `fill` / `stroke` value is one the converter can use: `none`, a `url()` reference
 * (its fallback color is checked by paint.ts), a context paint keyword, or a color it can parse.
 * Anything else (`env()`, `var()`, `color-mix()`, a typo…) is an invalid declaration: CSS ignores
 * it, so the next declaration in the cascade (the presentation attribute) or the parent's value applies.
 */
function isUsablePaint(value: string): boolean {
    const v = value.trim();
    return /^none$/i.test(v) || URL_PAINT.test(v) || CONTEXT_PAINT.test(v) || toAndroidColor(v, 1, '#000000') !== null;
}

/** CSS-wide keywords that resolve to the parent's value for an inherited property. */
const INHERIT_KEYWORDS = new Set(['inherit', 'unset', 'revert', 'revert-layer']);

/**
 * The `fill` / `stroke` declaration that applies on `el`: the inline `style` one, else the
 * attribute, skipping invalid values (`invalid`: the first one skipped). `inherit`, `unset` and
 * `revert` stand for the parent's value (`value` undefined; both properties are inherited);
 * `initial` resets it (`initial: true`: black fill, no stroke).
 */
function paintDeclaration(
    style: Record<string, string>,
    attrs: Record<string, string>,
    prop: 'fill' | 'stroke',
): { value?: string; invalid?: string; initial?: boolean } {
    let invalid: string | undefined;
    for (const v of [style[prop], attrs[prop]]) {
        if (v === undefined) continue;
        const keyword = v.trim().toLowerCase();
        if (INHERIT_KEYWORDS.has(keyword)) return { invalid };
        if (keyword === 'initial') return { invalid, initial: true };
        if (isUsablePaint(v)) return { value: v, invalid };
        invalid ??= v.trim();
    }
    return { invalid };
}

/** Inherited properties other than `fill` / `stroke` (see {@link paintDeclaration}). */
const INHERITABLE = [
    'fill-opacity',
    'fill-rule',
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
    for (const prop of ['fill', 'stroke'] as const) {
        const { value, invalid, initial } = paintDeclaration(style, attrs, prop);
        const declared = invalid !== undefined || value !== undefined || initial === true;
        if (prop === 'fill') {
            if (initial) next.fill = next.fillServer = undefined;
            else if (value !== undefined)
                ({ paint: next.fill, server: next.fillServer } = contextResolved(value, parent.context));
            if (declared) next.fillInvalid = invalid;
        } else {
            if (initial) next.stroke = next.strokeServer = undefined;
            else if (value !== undefined)
                ({ paint: next.stroke, server: next.strokeServer } = contextResolved(value, parent.context));
            if (declared) next.strokeInvalid = invalid;
        }
    }
    for (const prop of INHERITABLE) {
        const v = get(prop);
        // `inherit` keeps the parent's computed value, which `next` already holds.
        if (v === undefined || v.trim() === 'inherit') continue;
        if (prop === 'fill-opacity') next.fillOpacity = parseOpacity(v);
        else if (prop === 'fill-rule') next.fillRule = v;
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
    const matrix = parseTransform(attrs.transform);
    if (matrix) next.ctm = multiply(parent.ctm ?? IDENTITY, matrix);
    // The use's own paints (attributes, else inherited) are its content's context paints.
    if (attrs[USE_INSTANCE_ATTR] !== undefined)
        next.context = {
            fill: next.fill,
            stroke: next.stroke,
            fillNested: next.fillServer !== undefined,
            strokeNested: next.strokeServer !== undefined,
            element: el,
            ctm: next.ctm ?? IDENTITY,
            viewport: next.viewport,
            userSpace: attrs.transform === undefined,
        };
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
