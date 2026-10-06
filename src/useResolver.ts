import type { XastElement } from './gradient.js';
import { presentation } from './style.js';
import { formatMatrix } from './transform.js';
import { parseLength } from './units.js';
import { parseViewBox, viewBoxMatrix } from './viewport.js';

/**
 * Resolves `<use>` references in an SVG AST so the rest of the pipeline only ever sees concrete
 * geometry. svgo's `removeUselessDefs` / `inlineStyles` do not expand `<use>`, and a VectorDrawable
 * has no equivalent of "instance a symbol", so we inline each referenced subtree by hand.
 */

/** Max nesting of `<use>` → `<use>` we expand before giving up (guards against reference cycles). */
const MAX_DEPTH = 10;

/** Attributes consumed by `<use>` itself; they must not leak onto the inlined group as presentation. */
const USE_GEOMETRY_ATTRS = new Set(['href', 'xlink:href', 'x', 'y', 'width', 'height', 'id']);

/** Symbol attributes consumed by the viewport mapping; they must not linger on the inlined group. */
const SYMBOL_VIEWPORT_ATTRS = ['viewBox', 'preserveAspectRatio', 'width', 'height', 'overflow'] as const;

/** Prefix of the generated viewport clip ids (distinct from clip.ts's `svgvd-viewport-`). */
const CLIP_ID_PREFIX = 'svgvd-symbol-viewport-';

const isElement = (node: XastElement): boolean => node.type === 'element' && node.name !== undefined;

/** Reads a `<use>` target id, or undefined when the reference is absent / not a local `#id`. */
function targetId(use: XastElement): string | undefined {
    const href = use.attributes?.href ?? use.attributes?.['xlink:href'];
    if (href === undefined || !href.startsWith('#')) return undefined;
    return href.slice(1);
}

/** Indexes every element carrying an `id` (including those inside `<defs>`/`<symbol>`). */
function indexById(root: XastElement): Map<string, XastElement> {
    const byId = new Map<string, XastElement>();
    const visit = (node: XastElement): void => {
        const id = node.attributes?.id;
        // First id wins, matching how a browser resolves a duplicated id.
        if (id !== undefined && !byId.has(id)) byId.set(id, node);
        for (const child of node.children ?? []) visit(child);
    };
    visit(root);
    return byId;
}

/** Deep-clones an element so inlining never mutates (or aliases) the original target. */
function cloneElement(node: XastElement): XastElement {
    const clone: XastElement = { type: node.type };
    if (node.name !== undefined) clone.name = node.name;
    if (node.attributes !== undefined) clone.attributes = { ...node.attributes };
    if (node.children !== undefined) clone.children = node.children.map(cloneElement);
    return clone;
}

/**
 * Viewport size of a `<use>` instancing a `<symbol>`: the use's width/height win, then the
 * symbol's. A percentage (or a missing value) resolves against the parent viewport, which is not
 * known here: NaN, and the caller keeps the unscaled behaviour.
 */
function viewportLength(use: string | undefined, symbol: string | undefined): number {
    const raw = use !== undefined && use.trim() !== 'auto' ? use : symbol;
    return parseLength(raw);
}

/** Allocates clip ids that collide neither with the document's ids nor with each other. */
type IdAllocator = () => string;

function idAllocator(taken: ReadonlySet<string>): IdAllocator {
    let count = 0;
    return () => {
        let id: string;
        do id = `${CLIP_ID_PREFIX}${++count}`;
        while (taken.has(id));
        return id;
    };
}

/**
 * Wraps an inlined `<symbol viewBox>` so it renders like SVG instancing: the viewBox is mapped
 * onto the viewport (width×height at the use origin) and, unless the symbol's `overflow` is
 * `visible`/`auto`, clipped to it. Returns the children of the replacement group, or undefined
 * when no absolute viewport size is known (the caller then keeps the plain translate).
 * Layout: `[<g clip-path>[<clipPath>, <g transform=viewBox>[symbol]]]`, mirroring nested `<svg>`.
 */
function symbolViewport(
    use: XastElement,
    symbol: XastElement,
    clone: XastElement,
    nextId: IdAllocator,
): XastElement[] | undefined {
    const symbolAttrs = symbol.attributes ?? {};
    const vb = parseViewBox(symbolAttrs.viewBox);
    if (vb === undefined) return undefined;
    const width = viewportLength(use.attributes?.width, symbolAttrs.width);
    const height = viewportLength(use.attributes?.height, symbolAttrs.height);
    if (Number.isNaN(width) || Number.isNaN(height)) return undefined;
    // A zero (or negative) viewport disables rendering of the instance.
    if (!(width > 0 && height > 0)) return [];

    for (const attr of SYMBOL_VIEWPORT_ATTRS) delete clone.attributes?.[attr];
    const content: XastElement = {
        type: 'element',
        name: 'g',
        attributes: { transform: formatMatrix(viewBoxMatrix(vb, width, height, symbolAttrs.preserveAspectRatio)) },
        children: [clone],
    };

    const overflow = presentation(symbol, 'overflow')?.trim();
    if (overflow === 'visible' || overflow === 'auto') return [content];

    // The rect lives in the wrapper's user space, i.e. after the x/y translate: origin is (0, 0).
    // The clipPath sits inside the clipped group, where clip.ts still finds it by id.
    const id = nextId();
    const rect = { x: '0', y: '0', width: String(width), height: String(height) };
    const clipPath: XastElement = {
        type: 'element',
        name: 'clipPath',
        attributes: { id },
        children: [{ type: 'element', name: 'rect', attributes: rect }],
    };
    return [{ type: 'element', name: 'g', attributes: { 'clip-path': `url(#${id})` }, children: [clipPath, content] }];
}

/**
 * Builds the inlined replacement for a `<use>`: a deep clone of the target wrapped in a `<g>` that
 * carries the use's `x`/`y` translation (composed after any `transform` on the use) and its
 * presentation attributes. A `<symbol>` target is treated as a group (cloned, then renamed to `g`);
 * one with a `viewBox` is also scaled into, and clipped to, its viewport (see `symbolViewport`).
 */
function buildReplacement(use: XastElement, target: XastElement, nextId: IdAllocator): XastElement {
    const clone = cloneElement(target);
    let children: XastElement[] = [clone];
    if (clone.name === 'symbol') {
        clone.name = 'g';
        children = symbolViewport(use, target, clone, nextId) ?? children;
    }

    const attributes: Record<string, string> = {};

    const useAttrs = use.attributes ?? {};
    const x = useAttrs.x;
    const y = useAttrs.y;
    const baseTransform = useAttrs.transform;
    const translate = x !== undefined || y !== undefined ? `translate(${x ?? '0'} ${y ?? '0'})` : undefined;
    // SVG applies the use's own transform first, then the x/y offset — keep that order.
    const transform = [baseTransform, translate].filter((t): t is string => t !== undefined).join(' ');
    if (transform.length > 0) attributes.transform = transform;

    // Carry presentation attributes (fill, stroke, style, class, clip-path, opacity, …) but never
    // the use's geometry attributes — `transform` is rebuilt above so it is excluded here too.
    for (const [key, value] of Object.entries(useAttrs)) {
        if (USE_GEOMETRY_ATTRS.has(key) || key === 'transform') continue;
        attributes[key] = value;
    }

    return { type: 'element', name: 'g', attributes, children };
}

/**
 * Expands `<use>` elements in place. For each `<use>` with a resolvable local `#id`, the target is
 * deep-cloned and wrapped in a `<g>`; unresolvable references (missing target or non-`#` href) are
 * left untouched so they can be reported downstream. `<defs>` is preserved (gradients/clip-paths
 * still live there).
 */
export function resolveUses(root: XastElement): void {
    const byId = indexById(root);
    const nextId = idAllocator(new Set(byId.keys()));

    const resolveChildren = (node: XastElement, depth: number): void => {
        const children = node.children;
        if (children === undefined) return;

        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child === undefined) continue;

            if (isElement(child) && child.name === 'use') {
                const id = depth > 0 ? targetId(child) : undefined;
                const target = id !== undefined ? byId.get(id) : undefined;
                if (target !== undefined) {
                    const replacement = buildReplacement(child, target, nextId);
                    // Expand any `<use>` nested in the freshly inlined subtree, with less budget.
                    resolveChildren(replacement, depth - 1);
                    children[i] = replacement;
                    continue;
                }
                // Unresolvable (or depth exhausted): leave the <use> as-is.
            }

            resolveChildren(child, depth);
        }
    };

    resolveChildren(root, MAX_DEPTH);
}
