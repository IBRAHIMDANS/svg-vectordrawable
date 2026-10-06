import type { XastElement } from './gradient.js';
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
        if (prop === 'fill') next.fill = v;
        else if (prop === 'fill-opacity') next.fillOpacity = parseOpacity(v);
        else if (prop === 'fill-rule') next.fillRule = v;
        else if (prop === 'stroke') next.stroke = v;
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
