import type { Viewport, XastElement } from './ast.js';
import { validPathData } from './pathData.js';
import { shapeToPathData, SHAPE_NAMES } from './shapes.js';
import { cssPathString, isPathDataString, presentation, styleDeclarations, UNRESOLVED_CSS_PATH_DATA } from './style.js';

/** SMIL animation elements: a VectorDrawable is static, so the animated value is lost. */
export const ANIMATIONS = new Set(['animate', 'animateColor', 'animateMotion', 'animateTransform', 'discard', 'set']);

/** Elements a VectorDrawable cannot draw: reported, then skipped. */
export const UNSUPPORTED = new Set(['image', 'text', 'foreignObject', ...ANIMATIONS]);

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
    // Never executed: a script has no effect on a static render.
    'script',
    'linearGradient',
    'radialGradient',
    'clipPath',
    // Never rendered directly: only a reference to them matters, and references are reported
    // through UNSUPPORTED_ATTRS / paint resolution.
    'mask',
    'filter',
    'pattern',
    'marker',
    // Paint server of the SVG 2 drafts: a reference to it is reported by paint resolution.
    'hatch',
    // No effect on a static render: a link target view, a pointer cursor, SVG fonts (only `<text>`,
    // reported, uses them), an ICC profile declaration.
    'view',
    'cursor',
    'font',
    'font-face',
    'color-profile',
    // HTML media elements in the SVG namespace are unknown SVG elements: Chrome and Firefox draw
    // neither them nor their subtree (only the XHTML-namespace ones, under a `<foreignObject>`, are
    // media). svgo removes them as unknown elements.
    'video',
    'audio',
    'iframe',
    'canvas',
]);

/** Containers rendered as a plain group: `<a>` is a `<g>` whose link VectorDrawable cannot express. */
export const GROUPS = new Set(['g', 'a']);

/** True for `display: none` (the element and its subtree are not rendered). */
export const isDisplayNone = (el: XastElement): boolean => presentation(el, 'display')?.trim() === 'none';

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * `requiredExtensions` URIs a browser supports: foreign content in these namespaces renders there
 * (Chrome, Firefox), so the element must not be dropped silently — a `<foreignObject>` is reported.
 */
const SUPPORTED_EXTENSIONS = new Set(['http://www.w3.org/1999/xhtml', 'http://www.w3.org/1998/Math/MathML']);

/**
 * True when conditional processing (SVG 2 §5.8) excludes `el` from rendering: `requiredExtensions`
 * empty or naming an unsupported extension, or `systemLanguage` empty. A non-empty `systemLanguage`
 * depends on the device language (reported by the renderer); `requiredFeatures`, removed in SVG 2,
 * is ignored like browsers do. Resources (`<clipPath>`, gradients…) ignore their own conditions:
 * callers test the elements they render, never the referenced resource itself.
 */
export function failsConditions(el: XastElement): boolean {
    const { requiredExtensions, systemLanguage } = el.attributes ?? {};
    if (requiredExtensions !== undefined) {
        const uris = requiredExtensions.trim().split(/\s+/).filter(Boolean);
        if (!uris.length || uris.some((uri) => !SUPPORTED_EXTENSIONS.has(uri))) return true;
    }
    return systemLanguage !== undefined && systemLanguage.trim() === '';
}

/** Warning message for a non-empty `systemLanguage` on `<name>` (the root `<svg>` included). */
export const systemLanguageIgnored = (name: string): string =>
    `systemLanguage on <${name}> depends on the device language, which a VectorDrawable cannot test; ignored.`;

/** In-scope namespace bindings (`''` = default namespace) extended by `el`'s own `xmlns` declarations. */
function bindings(el: XastElement, scope: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
    let out: Map<string, string> | undefined;
    for (const [name, uri] of Object.entries(el.attributes ?? {})) {
        if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
        out ??= new Map(scope);
        out.set(name === 'xmlns' ? '' : name.slice('xmlns:'.length), uri);
    }
    return out ?? scope;
}

/**
 * Descendants of `root` outside the SVG namespace, resolved with XML namespace scoping (svgo keeps
 * the qualified name and the `xmlns` attributes only): e.g. the `<h:link>` of wpt reftests, an
 * editor's `<sodipodi:namedview>`. Neither they nor their subtree are rendered. A document without
 * any `xmlns` is read as SVG; an unbound prefix is foreign.
 */
export function foreignElements(root: XastElement): WeakSet<XastElement> {
    const out = new WeakSet<XastElement>();
    const visit = (node: XastElement, scope: ReadonlyMap<string, string>): void => {
        for (const child of node.children ?? []) {
            if (child.type !== 'element' || !child.name) continue;
            const own = bindings(child, scope);
            const colon = child.name.indexOf(':');
            if (own.get(colon < 0 ? '' : child.name.slice(0, colon)) !== SVG_NS) out.add(child);
            else visit(child, own);
        }
    };
    visit(root, bindings(root, new Map([['', SVG_NS]])));
    return out;
}

/** `d` values that compute to `none` (its initial value; `d` is not inherited). */
const D_NONE = new Set(['none', 'initial', 'unset']);
/**
 * Computed CSS `d`: path data (null when valid but drawing nothing, movetos alone), `none` (no
 * geometry), or a value the converter cannot resolve.
 */
type CssPathData = { d: string | null } | 'none' | 'unresolved';

/**
 * Reads one CSS `d` value; `undefined` for an invalid declaration (ignored by CSS). The string of
 * `path("…")`, once its CSS escapes are decoded, must be free of error: an error makes the
 * declaration invalid at parse time (Chrome, Firefox), unlike the attribute, which is rendered up
 * to the error. Movetos alone are valid: the path draws nothing, as with the attribute.
 */
function cssPathValue(value: string): CssPathData | undefined {
    const v = value.trim();
    if (D_NONE.has(v.toLowerCase())) return 'none';
    if (UNRESOLVED_CSS_PATH_DATA.test(v)) return 'unresolved';
    const d = cssPathString(v);
    if (d === undefined) return undefined;
    if (!d.trim()) return 'none'; // `path("")` computes to `none`
    return isPathDataString(d) ? { d: validPathData(d) } : undefined;
}

/**
 * The CSS `d` property of a `<path>`'s inline `style` (SVG 2 §9.3.1: it overrides the `d`
 * attribute; it does not apply to basic shapes): the last valid declaration wins, an `!important`
 * one over normal ones, invalid ones are ignored. `undefined` when no valid declaration sets it
 * (the attribute applies). `<style>` rules reach it once svgo inlined them (`optimize: true`).
 */
function cssPathData(el: XastElement): CssPathData | undefined {
    if (el.name !== 'path') return undefined;
    let normal: CssPathData | undefined;
    let important: CssPathData | undefined;
    for (const [name, raw, isImportant] of styleDeclarations(el.attributes?.style)) {
        if (name !== 'd') continue;
        const value = cssPathValue(raw);
        if (value === undefined) continue;
        if (isImportant) important = value;
        else normal = value;
    }
    return important ?? normal;
}

/**
 * True for a `<foreignObject>` without content (no element, only blank text or comments): it draws
 * nothing (Chrome, Firefox), and svgo removes it outside a `<switch>`. Not a `SKIP` element: a
 * `<switch>` still picks it (both browsers then render nothing), see {@link switchChild}.
 */
const isEmptyForeignObject = (el: XastElement): boolean =>
    el.name === 'foreignObject' &&
    (el.children ?? []).every(
        (c) =>
            c.type === 'comment' ||
            ((c.type === 'text' || c.type === 'cdata') && !(c as { value?: string }).value?.trim()),
    );

/**
 * {@link isNotRendered} but for the CSS `d` of a `<path>`: definitions and metadata (`SKIP`),
 * elements outside the SVG namespace (`foreign`, see `foreignElements`), failing conditional
 * processing, `display: none`, an empty `<foreignObject>`. A `<path>` excluded by its CSS `d` alone
 * still has that `d` reported (`applyCssProperties`).
 */
export const isNotRenderedButForPathData = (el: XastElement, foreign: WeakSet<XastElement>): boolean =>
    !el.name ||
    SKIP.has(el.name) ||
    foreign.has(el) ||
    failsConditions(el) ||
    isDisplayNone(el) ||
    isEmptyForeignObject(el);

/**
 * True when `el` and its subtree are never rendered, hence skipped without a warning: the reasons of
 * {@link isNotRenderedButForPathData}, or a `<path>` whose CSS `d` is `none` (what it asks for, not
 * an error: Chrome and Firefox draw nothing either) or a value the converter cannot resolve
 * (`var()`…: reported by `applyCssProperties` with `unsupported-style`).
 */
export const isNotRendered = (el: XastElement, foreign: WeakSet<XastElement>): boolean =>
    isNotRenderedButForPathData(el, foreign) || typeof cssPathData(el) === 'string'; // 'none' or 'unresolved'

/**
 * The child a `<switch>` renders (SVG 2 §5.6.3): the first direct child `failsConditions` keeps.
 * `display` / `visibility` take no part in the choice (a chosen `display: none` child renders
 * nothing). Only rendered SVG elements are candidates: text, foreign elements and `SKIP` elements
 * (`<title>`, `<desc>`…) are passed over, like Firefox (Chrome counts a `<desc>` as the chosen
 * child, hence renders nothing). A non-empty `systemLanguage` is resolved as in a device language
 * matching none of the listed ones (what both browsers render then): the first candidate without
 * `systemLanguage`, the author's catch-all; failing one, the first candidate (its language
 * assumed, as outside a `<switch>`). `languageDependent` is true when a candidate has a
 * `systemLanguage`, i.e. when a browser may pick another child (Firefox ranks the language
 * matches above the catch-all, whatever their order).
 */
export function switchChild(
    sw: XastElement,
    foreign: WeakSet<XastElement>,
): { child: XastElement | undefined; languageDependent: boolean } {
    const candidates = (sw.children ?? []).filter(
        (c): c is XastElement =>
            c.type === 'element' && !!c.name && !SKIP.has(c.name) && !foreign.has(c) && !failsConditions(c),
    );
    const catchAll = candidates.find((c) => c.attributes?.systemLanguage === undefined);
    return {
        child: catchAll ?? candidates[0],
        languageDependent: candidates.some((c) => c.attributes?.systemLanguage !== undefined),
    };
}

/**
 * Path data of a `<path>` or basic shape, or null when the element draws no geometry. A `d` in
 * error is cut after its last valid segment (SVG 2 §9.5.4, see {@link validPathData}). On a
 * `<path>`, a valid CSS `d` declaration overrides the attribute (see {@link cssPathData}); one the
 * converter cannot resolve (`var()`…) gives no geometry (see {@link isNotRendered}).
 */
export function pathDataOf(el: XastElement, viewport: Viewport, precision: number): string | null {
    if (el.name === 'path') {
        const css = cssPathData(el);
        if (css !== undefined) return typeof css === 'string' ? null : css.d;
        const d = el.attributes?.d;
        return d === undefined ? null : validPathData(d);
    }
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
