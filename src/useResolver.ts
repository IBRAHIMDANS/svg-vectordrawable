import type { Viewport, XastElement } from './ast.js';
import { USE_INSTANCE_ATTR } from './inherited.js';
import { isUnresolvableCssLength, presentation } from './style.js';
import { formatMatrix } from './transform.js';
import type { Warning } from './types.js';
import { parseLength } from './units.js';
import { nestedLayout, parseViewBox, rootLayout, viewBoxMatrix } from './viewport.js';

/**
 * Resolves `<use>` references in an SVG AST so the rest of the pipeline only ever sees concrete
 * geometry. svgo's `removeUselessDefs` / `inlineStyles` do not expand `<use>`, and a VectorDrawable
 * has no equivalent of "instance a symbol", so we inline each referenced subtree by hand.
 */

/** Max nesting of `<use>` → `<use>` we expand before giving up (guards against reference cycles). */
const MAX_DEPTH = 10;

/**
 * Max nodes cloned by `<use>` expansion in one document. Nesting multiplies instances (ten levels
 * of ten `<use>` each is 10^10 clones from a few hundred bytes), so depth alone bounds nothing.
 */
export const MAX_EXPANDED_NODES = 100_000;

/** Attributes consumed by `<use>` itself; they must not leak onto the inlined group as presentation. */
const USE_GEOMETRY_ATTRS = new Set(['href', 'xlink:href', 'x', 'y', 'width', 'height', 'id']);

/** Symbol attributes consumed by the viewport mapping; they must not linger on the inlined group. */
const SYMBOL_VIEWPORT_ATTRS = ['viewBox', 'preserveAspectRatio', 'width', 'height', 'overflow'] as const;

/** Symbol attributes consumed by the instance offset (SVG 2 §5.6), whatever its viewport. */
const SYMBOL_OFFSET_ATTRS = ['x', 'y'] as const;

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

/** Counts the nodes cloned so far; throws once the document's expansion budget is spent. */
type CloneBudget = () => void;

function cloneBudget(): CloneBudget {
    let cloned = 0;
    return () => {
        if (++cloned > MAX_EXPANDED_NODES)
            throw new Error(`<use> expansion exceeds ${MAX_EXPANDED_NODES} elements; refusing to convert.`);
    };
}

/** Deep-clones an element so inlining never mutates (or aliases) the original target. */
function cloneElement(node: XastElement, spend: CloneBudget): XastElement {
    spend();
    const clone: XastElement = { type: node.type };
    if (node.name !== undefined) clone.name = node.name;
    if (node.attributes !== undefined) clone.attributes = { ...node.attributes };
    if (node.children !== undefined) clone.children = node.children.map((child) => cloneElement(child, spend));
    return clone;
}

/** The `<use>` width/height that override its target's, or undefined when absent / `auto`. */
function useLength(value: string | undefined): string | undefined {
    return value !== undefined && value.trim() !== 'auto' ? value : undefined;
}

/**
 * Viewport length of a `<use>` instancing a `<symbol>` (SVG 2 §5.6.2): the use's width/height win,
 * then the symbol's, else `100%`. A percentage resolves against `ref`, the nearest viewport of the
 * `<use>`; NaN when that viewport is unknown (or the unit unsupported), and the caller keeps the
 * unscaled behaviour.
 */
function viewportLength(use: string | undefined, symbol: string | undefined, ref: number | undefined): number {
    return parseLength(useLength(use) ?? useLength(symbol) ?? '100%', ref);
}

/**
 * Size of the viewport the root `<svg>` establishes for its content (the reference of its
 * percentages): its viewBox, else its width/height. Undefined when the size is assumed (no viewBox
 * nor usable width/height) or the viewBox is invalid (convert reports both).
 */
function rootViewport(svg: XastElement): Viewport | undefined {
    try {
        const layout = rootLayout(svg.attributes ?? {});
        return layout.assumed.length > 0 ? undefined : layout.viewBox;
    } catch {
        return undefined;
    }
}

/**
 * Viewport a nested `<svg>` establishes for its content: its viewBox when set (known whatever the
 * parent), else its width/height resolved against the parent viewport (see `nestedLayout`).
 */
function nestedViewport(svg: XastElement, parent: Viewport | undefined): Viewport | undefined {
    const vb = parseViewBox(svg.attributes?.viewBox);
    if (vb !== undefined) return { width: vb[2], height: vb[3] };
    return parent === undefined ? undefined : (nestedLayout(svg, parent)?.viewport ?? undefined);
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
 * Wraps an inlined `<symbol>` so it renders like SVG instancing: a viewBox, if any, is mapped onto
 * the viewport (width×height at the use origin, percentages against `parent`, the nearest viewport
 * of the `<use>`) and, unless the symbol's `overflow` is `visible`/`auto`, the content is clipped
 * to that viewport. Returns the children of the replacement group and the viewport the symbol
 * establishes for its content, or undefined when the viewport size cannot be resolved (the caller
 * then keeps the plain translate). Layout: `[<g clip-path>[<clipPath>, <g transform=viewBox>[symbol]]]`,
 * mirroring nested `<svg>`; without a viewBox the scale group is omitted (`[symbol]`).
 */
function symbolViewport(
    use: XastElement,
    symbol: XastElement,
    clone: XastElement,
    nextId: IdAllocator,
    parent: Viewport | undefined,
): { children: XastElement[]; viewport: Viewport } | undefined {
    const symbolAttrs = symbol.attributes ?? {};
    const vb = parseViewBox(symbolAttrs.viewBox);
    const width = viewportLength(use.attributes?.width, symbolAttrs.width, parent?.width);
    const height = viewportLength(use.attributes?.height, symbolAttrs.height, parent?.height);
    if (Number.isNaN(width) || Number.isNaN(height)) return undefined;
    const viewport = vb === undefined ? { width, height } : { width: vb[2], height: vb[3] };
    // A zero (or negative) viewport disables rendering of the instance.
    if (!(width > 0 && height > 0)) return { children: [], viewport };

    for (const attr of SYMBOL_VIEWPORT_ATTRS) delete clone.attributes?.[attr];
    const content: XastElement =
        vb === undefined
            ? clone
            : {
                  type: 'element',
                  name: 'g',
                  attributes: {
                      transform: formatMatrix(viewBoxMatrix(vb, width, height, symbolAttrs.preserveAspectRatio)),
                  },
                  children: [clone],
              };

    const overflow = presentation(symbol, 'overflow')?.trim();
    if (overflow === 'visible' || overflow === 'auto') return { children: [content], viewport };

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
    return {
        children: [
            { type: 'element', name: 'g', attributes: { 'clip-path': `url(#${id})` }, children: [clipPath, content] },
        ],
        viewport,
    };
}

/** Reports a warning; a no-op where nothing is rendered (expansion inside a bare `<symbol>`). */
type Report = (w: Warning) => void;

/**
 * Resolves an `x` / `y` offset of a `<use>` or of the `<symbol>` it instances into user units: a
 * percentage against `ref` (the matching size of the nearest viewport of the `<use>`). Absent is 0,
 * and so is a value that is not a length (`""`, `foo`): a browser uses the initial value. A length
 * the converter cannot resolve (`ex`, `ch`, `calc()`, `%` of an unknown viewport…) is reported and
 * taken as 0.
 */
function offsetOf(
    value: string | undefined,
    ref: number | undefined,
    attr: string,
    node: string,
    id: string,
    report: Report,
): number {
    if (value === undefined) return 0;
    const parsed = parseLength(value, ref);
    if (!Number.isNaN(parsed)) return parsed;
    const trimmed = value.trim();
    // Any reference: only whether the value is a length matters here.
    if (Number.isNaN(parseLength(trimmed, 1)) && !isUnresolvableCssLength(trimmed, false)) return 0;
    report({
        code: 'unsupported-attribute',
        message: `<use href="#${id}">: ${attr}="${trimmed}" on <${node}> is not a length the converter can resolve (ex, ch, calc(), a percentage of a viewport of unknown size…); it is taken as 0.`,
        node: 'use',
    });
    return 0;
}

/** True when an unresolved symbol viewport changes nothing: no viewBox to scale, no clip. */
function viewportIrrelevant(symbol: XastElement): boolean {
    if (parseViewBox(symbol.attributes?.viewBox) !== undefined) return false;
    const overflow = presentation(symbol, 'overflow')?.trim();
    return overflow === 'visible' || overflow === 'auto';
}

/**
 * Builds the inlined replacement for a `<use>`: a deep clone of the target wrapped in a `<g>` that
 * carries the use's `x`/`y` translation (composed after any `transform` on the use; lengths
 * resolved against `parent`), its presentation attributes and the `USE_INSTANCE_ATTR` mark (context
 * element, see inherited.ts). A `<symbol>` target is treated as a group (cloned, then renamed to
 * `g`), clipped to its viewport and, with a `viewBox`, scaled into it (see `symbolViewport`); when
 * that viewport cannot be resolved, it is neither (reported). The symbol's own `x`/`y` translate
 * all that inside the wrapper, like a nested `<svg>`. On an `<svg>` target, the use's width/height
 * override the svg's own (the nested-svg walker does the rest). Also returns the viewport of the
 * replacement's content: the symbol's, else `parent` (the nearest viewport of the `<use>`).
 */
function buildReplacement(
    use: XastElement,
    target: XastElement,
    nextId: IdAllocator,
    spend: CloneBudget,
    parent: Viewport | undefined,
    report: Report,
): { replacement: XastElement; viewport: Viewport | undefined } {
    const clone = cloneElement(target, spend);
    const id = target.attributes?.id ?? '';
    const useAttrs = use.attributes ?? {};
    let children: XastElement[] = [clone];
    let viewport = parent;
    if (clone.name === 'symbol') {
        clone.name = 'g';
        for (const attr of SYMBOL_OFFSET_ATTRS) delete clone.attributes?.[attr];
        const instance = symbolViewport(use, target, clone, nextId, parent);
        if (instance !== undefined) ({ children, viewport } = instance);
        else {
            viewport = undefined;
            if (!viewportIrrelevant(target))
                report({
                    code: 'unsupported-attribute',
                    message: `<use href="#${id}">: the <symbol> viewport size (a percentage or absent width / height against a viewport of unknown size, or an unsupported unit) cannot be resolved; the symbol is neither clipped nor scaled to it. Give the <use> or the <symbol> an absolute width and height.`,
                    node: 'use',
                });
        }
    } else if (clone.name === 'svg' && clone.attributes !== undefined) {
        for (const attr of ['width', 'height'] as const) {
            const value = useLength(use.attributes?.[attr]);
            if (value !== undefined) clone.attributes[attr] = value;
        }
    }

    // A symbol acts as a nested <svg> inside the use: its x / y offset its viewport (clip, viewBox)
    // within the use's space, so they go on an inner group, not on the wrapper (where the use's own
    // clip-path / mask apply). Numbers only: parseTransform cannot read units nor percentages.
    const offset = (attrs: Record<string, string>, node: string): string | undefined => {
        if (attrs.x === undefined && attrs.y === undefined) return undefined;
        const x = offsetOf(attrs.x, parent?.width, 'x', node, id, report);
        const y = offsetOf(attrs.y, parent?.height, 'y', node, id, report);
        return `translate(${x} ${y})`;
    };
    const symbolOffset =
        target.name === 'symbol' && children.length > 0 ? offset(target.attributes ?? {}, 'symbol') : undefined;
    if (symbolOffset !== undefined)
        children = [{ type: 'element', name: 'g', attributes: { transform: symbolOffset }, children }];

    const attributes: Record<string, string> = {};

    const baseTransform = useAttrs.transform;
    const translate = offset(useAttrs, 'use');
    // SVG applies the use's own transform first, then the x/y offset — keep that order.
    const transform = [baseTransform, translate].filter((t): t is string => t !== undefined).join(' ');
    if (transform.length > 0) attributes.transform = transform;

    // Carry presentation attributes (fill, stroke, style, class, clip-path, opacity, …) but never
    // the use's geometry attributes — `transform` is rebuilt above so it is excluded here too.
    for (const [key, value] of Object.entries(useAttrs)) {
        if (USE_GEOMETRY_ATTRS.has(key) || key === 'transform') continue;
        attributes[key] = value;
    }
    // The replacement is the context element of its content (`context-fill` / `context-stroke`).
    attributes[USE_INSTANCE_ATTR] = '';

    return { replacement: { type: 'element', name: 'g', attributes, children }, viewport };
}

/** The viewport a `<symbol>` establishes on its own (its viewBox), for its bare, unrendered content. */
function bareSymbolViewport(symbol: XastElement): Viewport | undefined {
    const vb = parseViewBox(symbol.attributes?.viewBox);
    return vb === undefined ? undefined : { width: vb[2], height: vb[3] };
}

/**
 * Expands `<use>` elements in place. For each `<use>` with a resolvable local `#id`, the target is
 * deep-cloned and wrapped in a `<g>`; unresolvable references (missing target or non-`#` href) are
 * left untouched so they can be reported downstream. `<defs>` is preserved (gradients/clip-paths
 * still live there). Throws when the expansion clones more than `MAX_EXPANDED_NODES` nodes.
 *
 * The percentages of an instanced `<symbol>` resolve against the nearest viewport of its `<use>`
 * (root `<svg>`, nested `<svg>` or instanced `<symbol>`), tracked along the walk; every instance is
 * cloned from the unexpanded target, then expanded under its own viewport. The content of a
 * bare `<symbol>` (rendered only through a `<use>`) is expanded after the walk, silently: it is
 * never rendered as such. `warn` receives the instanced symbols whose viewport cannot be resolved
 * and the `x` / `y` offsets that cannot be resolved, each message once (a symbol instanced by
 * several `<use>` is reported once).
 */
export function resolveUses(root: XastElement, warn: Report = () => undefined): void {
    // Instances are cloned from an unexpanded copy: a target expanded in place (a <use> in <defs>,
    // or a rendered group) resolved its percentages against its own location's viewport, not the
    // one it is instanced in. The copy is the input's size, so it does not spend the budget.
    const byId = indexById(cloneElement(root, () => undefined));
    const nextId = idAllocator(new Set(byId.keys()));
    const spend = cloneBudget();

    const resolveChildren = (
        node: XastElement,
        depth: number,
        vp: Viewport | undefined,
        report: Report,
        skipSymbols: boolean,
    ): void => {
        const children = node.children;
        if (children === undefined) return;

        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            if (child === undefined || !isElement(child)) continue;

            if (child.name === 'use') {
                const id = depth > 0 ? targetId(child) : undefined;
                const target = id !== undefined ? byId.get(id) : undefined;
                if (target !== undefined) {
                    const built = buildReplacement(child, target, nextId, spend, vp, report);
                    // Expand any `<use>` nested in the freshly inlined subtree, with less budget.
                    resolveChildren(built.replacement, depth - 1, built.viewport, report, skipSymbols);
                    children[i] = built.replacement;
                    continue;
                }
                // Unresolvable (or depth exhausted): leave the <use> as-is.
            }

            if (child.name === 'symbol' && skipSymbols) continue;
            let childVp = vp;
            if (child.name === 'svg') childVp = node.type === 'root' ? rootViewport(child) : nestedViewport(child, vp);
            else if (child.name === 'symbol') childVp = bareSymbolViewport(child);
            resolveChildren(child, depth, childVp, report, skipSymbols);
        }
    };

    const reported = new Set<string>();
    const report: Report = (w) => {
        if (reported.has(w.message)) return;
        reported.add(w.message);
        warn(w);
    };
    resolveChildren(root, MAX_DEPTH, undefined, report, true);

    // Bare symbols last: an element inside one (a clipPath…) may still be referenced by id.
    const silent: Report = () => undefined;
    const expandSymbols = (node: XastElement): void => {
        for (const child of node.children ?? []) {
            if (!isElement(child)) continue;
            if (child.name === 'symbol') resolveChildren(child, MAX_DEPTH, bareSymbolViewport(child), silent, false);
            else expandSymbols(child);
        }
    };
    expandSymbols(root);
}
