import type { XastElement } from './ast.js';
import {
    aroundOrigin,
    formatMatrix,
    isIdentity,
    parseCssTransform,
    parseTransform,
    parseTransformOrigin,
    type Matrix,
} from './transform.js';
import type { Warning } from './types.js';

/** Parses an inline `style` attribute into a lowercase-keyed declaration map. */
export function parseStyle(style: string | undefined): Record<string, string> {
    if (!style) return {};
    const out: Record<string, string> = {};
    for (const decl of style.split(';')) {
        const i = decl.indexOf(':');
        if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).trim();
    }
    return out;
}

/** Reads a property from the inline `style` first, then from the attribute of the same name. */
export function presentation(el: XastElement, name: string): string | undefined {
    const attrs = el.attributes ?? {};
    return parseStyle(attrs.style)[name] ?? attrs[name];
}

export const isNone = (v: string | undefined): boolean => v === undefined || v.trim().toLowerCase() === 'none';

/** Elements whose own `*Transform` attribute (not `transform`) positions them: left untouched. */
const OWN_TRANSFORM_ATTRIBUTE = new Set(['linearGradient', 'radialGradient', 'pattern']);
/** Declarations folded into the `transform` attribute (also read as attributes, except `transform`). */
const TRANSFORM_PROPERTIES = ['transform', 'transform-origin', 'transform-box'] as const;
/** `transform-box` values equivalent to SVG's default reference box (the nearest viewport). */
const VIEW_BOX = new Set(['view-box', 'initial', 'unset', 'revert']);
/** `mix-blend-mode` values that blend nothing. */
const NO_BLEND = new Set(['normal', 'initial', 'unset', 'revert']);

type Warn = (w: Warning) => void;

/** Removes declarations from an element's inline `style` (dropping the attribute once empty). */
function removeDeclarations(attrs: Record<string, string>, names: readonly string[]): void {
    const declarations = Object.entries(parseStyle(attrs.style));
    const kept = declarations.filter(([k]) => !names.includes(k));
    if (kept.length === declarations.length) return; // nothing to remove: keep the author's formatting
    if (kept.length) attrs.style = kept.map(([k, v]) => `${k}:${v}`).join(';');
    else delete attrs.style;
}

/**
 * Folds the CSS `transform` property and `transform-origin` (CSS or attribute) of a non-root element
 * into its `transform` attribute, which is all the rest of the converter reads. The CSS property
 * overrides the attribute; the origin applies to either. What no matrix can express (a percentage
 * or keyword of the reference box, `transform-box` other than `view-box`, 3D) is reported and the
 * element left as it was, i.e. the CSS ignored.
 */
function foldTransform(el: XastElement, name: string, warn: Warn): void {
    const attrs = el.attributes!;
    const css = parseStyle(attrs.style);
    const cssTransform = css.transform;
    const origin = css['transform-origin'] ?? attrs['transform-origin'];
    const box = css['transform-box'] ?? attrs['transform-box'];
    if (cssTransform === undefined && origin === undefined && box === undefined) return;
    const ignored = (what: string, why: string): void =>
        warn({ code: 'unsupported-style', message: `${what} on <${name}> ${why}; ignored.`, node: name });

    let matrix: Matrix | null = parseTransform(attrs.transform);
    if (cssTransform !== undefined) {
        matrix = parseCssTransform(cssTransform);
        if (!matrix) return ignored(`transform: ${cssTransform}`, 'is not a 2D transform with absolute units');
    }
    if (matrix && !isIdentity(matrix)) {
        if (box !== undefined && !VIEW_BOX.has(box.trim().toLowerCase()))
            return ignored(`transform-box: ${box}`, 'needs the element bounding box (only view-box is supported)');
        const o = origin === undefined ? { x: 0, y: 0 } : parseTransformOrigin(origin);
        if (!o) return ignored(`transform-origin: ${origin}`, 'needs the reference box (only absolute lengths)');
        if (cssTransform !== undefined || o.x !== 0 || o.y !== 0)
            attrs.transform = formatMatrix(aroundOrigin(matrix, o.x, o.y));
    } else if (cssTransform !== undefined) delete attrs.transform; // `transform: none` overrides the attribute
    removeDeclarations(attrs, TRANSFORM_PROPERTIES);
    delete attrs['transform-origin'];
    delete attrs['transform-box'];
}

/**
 * Applies, or reports, the CSS properties the rest of the converter does not read: `transform`,
 * `transform-origin` and `transform-box` are folded into `transform` attributes (see
 * `foldTransform`); a `mix-blend-mode` other than `normal` is reported (`unsupported-style`).
 * Mutates the tree; run it before `<use>` expansion, so that clones inherit the folded attributes.
 * The root `<svg>` is left to the root layout (`src/convert.ts`), which reports its CSS transform.
 */
export function applyCssProperties(root: XastElement, warn: Warn): void {
    const visit = (el: XastElement, outermost: boolean): void => {
        const name = el.name!;
        const attrs = (el.attributes ??= {});
        const style = parseStyle(attrs.style);
        const blend = style['mix-blend-mode']?.trim().toLowerCase();
        if (blend !== undefined && !NO_BLEND.has(blend))
            warn({
                code: 'unsupported-style',
                message: `mix-blend-mode: ${blend} on <${name}> cannot be represented in a VectorDrawable; ignored.`,
                node: name,
            });
        // The root <svg> transform is the root layout's business (its default origin is its box centre).
        if (!outermost && !OWN_TRANSFORM_ATTRIBUTE.has(name)) foldTransform(el, name, warn);
        for (const child of el.children ?? []) if (child.type === 'element' && child.name) visit(child, false);
    };
    for (const child of root.children ?? [])
        if (child.type === 'element' && child.name) visit(child, root.type === 'root' && child.name === 'svg');
}
