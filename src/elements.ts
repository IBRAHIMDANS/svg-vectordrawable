import type { Viewport, XastElement } from './gradient.js';
import { shapeToPathData, SHAPE_NAMES } from './shapes.js';
import { presentation } from './style.js';

/** Elements a VectorDrawable cannot draw: reported, then skipped. */
export const UNSUPPORTED = new Set(['image', 'text', 'foreignObject', 'switch']);

/** Presentation attributes that reference features a VectorDrawable cannot express. */
export const UNSUPPORTED_ATTRS = ['mask', 'filter', 'marker', 'marker-start', 'marker-mid', 'marker-end'] as const;

/** Elements never rendered directly (definitions, metadata), silently skipped. */
export const SKIP = new Set([
    'defs',
    'symbol',
    'metadata',
    'title',
    'desc',
    'style',
    'linearGradient',
    'radialGradient',
    'clipPath',
    // Never rendered directly: only a reference to them matters, and references are reported
    // through UNSUPPORTED_ATTRS / paint resolution.
    'mask',
    'filter',
    'pattern',
    'marker',
]);

/** Containers rendered as a plain group: `<a>` is a `<g>` whose link VectorDrawable cannot express. */
export const GROUPS = new Set(['g', 'a']);

/** True for `display: none` (the element and its subtree are not rendered). */
export const isDisplayNone = (el: XastElement): boolean => presentation(el, 'display')?.trim() === 'none';

/** Path data of a `<path>` or basic shape, or null when the element draws no geometry. */
export function pathDataOf(el: XastElement, viewport: Viewport, precision: number): string | null {
    if (el.name === 'path') return el.attributes?.d ?? null;
    if (el.name && SHAPE_NAMES.has(el.name))
        return shapeToPathData(el.name, el.attributes ?? {}, { viewport, precision });
    return null;
}

/** Appends every descendant element whose name is in `names` (document order). */
export function collectByName(node: XastElement, names: Set<string>, out: XastElement[]): void {
    for (const child of node.children ?? []) {
        if (child.type === 'element') {
            if (child.name && names.has(child.name)) out.push(child);
            collectByName(child, names, out);
        }
    }
}
