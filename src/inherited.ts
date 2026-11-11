import type { XastElement } from './ast.js';
import { toAndroidColor } from './color.js';
import { isValidPropertyValue, parseStyle } from './style.js';
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
     * The `fill` declaration ignored as unusable (trimmed) on the way to the computed `fill`: on this
     * element, or on an ancestor whose value it inherits. paint.ts reports it; undefined once an
     * element declares a valid `fill`, and for a value a browser drops at parse time too (a typo).
     */
    fillInvalid?: string;
    /** The ignored `stroke` declaration (see `fillInvalid`). */
    strokeInvalid?: string;
    /**
     * The `color` declaration holding a substitution (`var()`, `env()`, `attr()`) that the computed
     * `color` ignores (CSS Variables 1 §3.1: it wins over the attribute, then acts as `unset`, the
     * parent's color): on this element or an ancestor it inherits from. paint.ts reports it where
     * `currentColor` is painted; undefined once an element declares a usable `color`.
     */
    colorUnresolved?: string;
    /**
     * The other inherited properties (see {@link INHERITABLE}) whose computed value ignores such a
     * declaration (see `colorUnresolved`), by name; paint.ts reports those the path paints with.
     */
    unresolved?: Readonly<Record<string, string>>;
    /**
     * Inherited text properties (see {@link TEXT_PROPERTIES}) by name, as declared on the nearest
     * element setting them; a relative `font-size` (`em`, `%`) is resolved to px against the
     * parent's. Read by text.ts only; undefined until an element declares one.
     */
    text?: Readonly<Record<string, string>>;
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
    /**
     * `ctm` of the content (inside the instance's transform: the use's `transform`, then its x/y
     * offset). It is also the use's user space, where a `userSpaceOnUse` paint server lives
     * (SVG 2 §5.6.2; Chromium agrees).
     */
    ctm: Matrix;
    viewport: Viewport;
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
 * A paint server reference, local (`#id`) or not, and its fallback (group 1, may be empty). The
 * fallback is what decides whether the declaration parses, whatever the reference points to.
 */
const URL_WITH_FALLBACK = /^url\(\s*(?:'[^']*'|"[^"]*"|[^'"()\s]*)\s*\)\s*(.*)$/is;
/** Substitution functions: never resolved here (no custom properties), a browser drops what it cannot substitute. */
const SUBSTITUTION = /\b(?:var|env|attr)\(/i;

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

const isUsableColor = (v: string): boolean => toAndroidColor(v, 1, '#000000') !== null;

/**
 * true when a `fill` / `stroke` value is one the converter can use: `none`, a `url()` reference
 * whose fallback is empty, `none` or a color it can parse (paint.ts resolves or reports the reference
 * itself: a non-local one falls back to that color), a context paint keyword, or such a color.
 * Anything else (`env()`, `var()`, `color-mix()`, a typo…) is an invalid declaration: CSS ignores
 * it, so the next declaration in the cascade (the presentation attribute) or the parent's value applies.
 */
export function isUsablePaint(value: string): boolean {
    const v = value.trim();
    const url = URL_WITH_FALLBACK.exec(v);
    if (url) {
        const fallback = url[1]!.trim();
        return fallback === '' || /^none$/i.test(fallback) || isUsableColor(fallback);
    }
    // A malformed `url()` is left to paint.ts, which reports it.
    return /^none$/i.test(v) || URL_PAINT.test(v) || CONTEXT_PAINT.test(v) || isUsableColor(v);
}

/** CSS-wide keywords that resolve to the parent's value for an inherited property. */
const INHERIT_KEYWORDS = new Set(['inherit', 'unset', 'revert', 'revert-layer']);
const CSS_WIDE_KEYWORDS = new Set([...INHERIT_KEYWORDS, 'initial']);

/**
 * true when a `fill` / `stroke` value the converter cannot use is one a browser drops at parse time
 * too (a typo, a malformed fallback after `url()`): ignoring it is the browser's rendering, nothing
 * to report. A substitution or color function (`env()`, `color-mix()`…) may mean something else.
 */
function isInvalidPaint(prop: 'fill' | 'stroke', value: string): boolean {
    const v = value.trim();
    const fallback = URL_WITH_FALLBACK.exec(v)?.[1]?.trim();
    // A CSS-wide keyword is a whole value: `url(#g) inherit` does not parse.
    if (fallback !== undefined && CSS_WIDE_KEYWORDS.has(fallback.toLowerCase())) return true;
    return !isValidPropertyValue(prop, fallback ?? v);
}

/**
 * The `fill` / `stroke` declaration that applies on `el`: the inline `style` one, else the
 * attribute, skipping values the converter cannot use (`invalid`: the first one skipped that a
 * browser may not drop, see {@link isInvalidPaint}; paint.ts reports it). `inherit`, `unset` and
 * `revert` stand for the parent's value (`value` undefined; both properties are inherited);
 * `initial` resets it (`initial: true`: black fill, no stroke). So does a substitution
 * (`var()`, `env()`, `attr()`, reported as `invalid`): it wins over the attribute, then acts as `unset`.
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
        if (SUBSTITUTION.test(v)) return { invalid: invalid ?? v.trim() };
        if (!isInvalidPaint(prop, v)) invalid ??= v.trim();
    }
    return { invalid };
}

/** Inherited properties other than `fill` / `stroke` (see {@link paintDeclaration}). */
export const INHERITABLE = [
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

/** Inherited properties read when `<text>` is laid out with a font (`fonts` option, see text.ts). */
export const TEXT_PROPERTIES = [
    'font',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'font-variant',
    'font-variant-caps',
    'font-variant-ligatures',
    'font-variant-numeric',
    'font-stretch',
    'font-kerning',
    'font-size-adjust',
    'font-feature-settings',
    'font-variation-settings',
    'letter-spacing',
    'word-spacing',
    'text-transform',
    'text-anchor',
    'direction',
    'writing-mode',
    'dominant-baseline',
    'white-space',
    'xml:space',
] as const;

/** An inherited property other than `fill` / `stroke`, as an attribute (value in group 2 or 3) or a CSS declaration (group 4). */
const INHERITABLE_VALUE = new RegExp(
    `(?<![\\w:-])(${INHERITABLE.join('|')})\\s*(?:=\\s*(?:"([^"]*)"|'([^']*)')|:\\s*([^;}"'<]*))`,
    'gi',
);

/**
 * true when some attribute or CSS declaration of an inherited property (see {@link INHERITABLE})
 * holds a value resolveStyle ignores, letting the parent's value apply. svgo treats it as a regular
 * value (`collapseGroups` drops the group's value above it, `moveElemsAttrsToGroup` hoists it): the
 * value to fall back to is gone before the converter runs. For the svgo pass to keep groups as authored.
 */
export function hasIgnoredPresentationValue(svg: string): boolean {
    for (const m of svg.matchAll(INHERITABLE_VALUE)) {
        const name = m[1]!.toLowerCase();
        const value = (m[2] ?? m[3] ?? m[4] ?? '').replace(/\s*!\s*important\s*$/i, '');
        if (
            !isValidPropertyValue(name, value) ||
            SUBSTITUTION.test(value) ||
            (name === 'color' && isCurrentColor(value))
        )
            return true;
    }
    return false;
}

/** A `font-size` in `em` / `%` as px of the parent's (16 px, `medium`, when unset); others as declared. */
function absoluteFontSize(value: string, parent: string | undefined): string {
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(em|%)$/i.exec(value);
    if (!m) return value;
    const base = parseLength(parent ?? '16');
    return Number.isNaN(base) ? value : String((parseFloat(m[1]!) / (m[2] === '%' ? 100 : 1)) * base);
}

/** Initial style of the document: SVG defaults, `currentColor` resolved to `color`. */
export const initialStyle = (color: string, viewport: Viewport): Inherited => ({
    fillOpacity: 1,
    strokeOpacity: 1,
    color,
    opacityMul: 1,
    viewport,
});

/** `color: currentColor` is the parent's color. */
const isCurrentColor = (v: string): boolean => /^currentcolor$/i.test(v.trim());

/**
 * Computes an element's style from its parent's (inline `style` wins over attributes). A presentation
 * attribute whose value is invalid for its property is ignored like an invalid `style` declaration
 * (see `isValidPropertyValue`): the parent's value applies.
 */
export function resolveStyle(el: XastElement, parent: Inherited): Inherited {
    const attrs = el.attributes ?? {};
    const style = parseStyle(attrs.style);
    const get = (name: string): string | undefined => style[name] ?? attrs[name];
    /**
     * The declaration that applies: the `style` one (validated by parseStyle), else a valid attribute.
     * One with a substitution (`unresolved`) wins too, then stands for the parent's value.
     */
    const declared = (name: string): { value?: string; unresolved?: string } => {
        for (const v of [style[name], attrs[name]]) {
            if (v === undefined || !isValidPropertyValue(name, v)) continue;
            if (SUBSTITUTION.test(v)) return { unresolved: v.trim() };
            return { value: name === 'color' && isCurrentColor(v) ? 'inherit' : v };
        }
        return {};
    };
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
        const { value: v, unresolved } = declared(prop);
        if (unresolved !== undefined) {
            if (prop === 'color') next.colorUnresolved = unresolved;
            else next.unresolved = { ...next.unresolved, [prop]: unresolved };
        }
        // `inherit` keeps the parent's computed value, which `next` already holds.
        if (v === undefined || v.trim() === 'inherit') continue;
        if (prop === 'color') next.colorUnresolved = undefined;
        else if (next.unresolved?.[prop] !== undefined) {
            const rest = { ...next.unresolved };
            delete rest[prop];
            next.unresolved = rest;
        }
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
    for (const prop of TEXT_PROPERTIES) {
        const v = get(prop)?.trim();
        if (v === undefined || v === 'inherit') continue;
        const value = prop === 'font-size' ? absoluteFontSize(v, parent.text?.[prop]) : v;
        next.text = { ...next.text, [prop]: value };
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
