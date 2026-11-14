import { optimize } from './svgo.js';
import type { Config } from 'svgo';
import type { XastRoot } from './ast.js';
import { hasIgnoredPresentationValue, isUsablePaint } from './inherited.js';
import { matrixScale, scaledPrecision, validPathData } from './pathData.js';
import { parsePoints } from './shapes.js';
import { cascadedStyle } from './style.js';
import { isInvalidTransform, parseCssTransform, parseTransform, type Matrix } from './transform.js';
import { rootExtraDigits, rootLayout } from './viewport.js';

/**
 * Default normalization: flatten inline `<style>`, turn shapes into paths, bake transforms and
 * collapse trivial groups. This is what lets one walker handle SVGs from any editor.
 * `viewBox` is preserved (svgo 4's preset-default no longer strips it).
 */
const DEFAULT_OVERRIDES = {
    inlineStyles: { onlyMatchedOnce: false },
    convertShapeToPath: { convertArcs: true },
    // svgo 4.1 mis-reflects a smooth `s` that follows a cubic rewritten to `q`
    // (`c3-2 6-2 9 0s6 2 9 0` → wrong first control point). Keep cubics as cubics.
    // `makeArcs` rewrites curves that fit a circle as arcs, then rounds the radius and the end
    // point separately: on a (near) half circle, `a6.999 6.999 0 1 0 0 13.996` puts the centre
    // ~0.12 unit off the chord, since the offset grows as sqrt(r × rounding error). Its
    // threshold / tolerance only bound the fit, not that rounding, so it is turned off.
    convertPathData: { convertToQ: false, makeArcs: false },
    // Keep ids: gradients / clip-paths are referenced by url(#id). Not minified either: the
    // warnings quote them (`url(#a)` would not be found in the source), and the output carries
    // none (outside `preserveIds`), so renaming saves nothing.
    cleanupIds: { remove: false, minify: false },
};

/**
 * svgo's `mergePaths` is quadratic: each candidate is intersection-tested against the whole
 * path accumulated so far. Worst case measured (dense, same-style, touching paths): 500 paths
 * ≈ 100 ms, 1,000 ≈ 250 ms, 5,000 ≈ 6.7 s vs 0.3 s without it. Icons sit far below the
 * threshold and keep the merge (fewer `<path>` in the output); large illustrations skip it.
 */
const MERGE_PATHS_MAX_ELEMENTS = 500;

const DRAWABLE_TAG = /<(?:path|rect|circle|ellipse|line|polyline|polygon)[\s/>]/g;
const COMMENT = /<!--[\s\S]*?-->/g;

/** Cheap pre-count of drawable elements, stopping as soon as `limit` is exceeded. */
function exceedsDrawableCount(svg: string, limit: number): boolean {
    const source = svg.includes('<!--') ? svg.replace(COMMENT, '') : svg;
    const tag = new RegExp(DRAWABLE_TAG);
    let count = 0;
    while (tag.exec(source)) {
        if (++count > limit) return true;
    }
    return false;
}

/**
 * svgo's `convertPathData` is quadratic in the number of relative commands of one path, whatever
 * its parameters. Measured on a single path of relative lines: 5,000 segments ≈ 50 ms, 10,000 ≈
 * 0.5 s, 20,000 ≈ 2.5 s, 80,000 ≈ 53 s (61 ms without it). Icons sit far below the threshold and
 * keep the optimization (shorter `pathData`); a document holding a longer `d` is converted as
 * authored, as with `optimize: false`.
 */
const CONVERT_PATH_DATA_MAX_LENGTH = 50_000;

const PATH_DATA_ATTR = /\sd\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** True when some `d` attribute is longer than `limit` characters. */
function exceedsPathDataLength(svg: string, limit: number): boolean {
    if (svg.length <= limit) return false;
    for (const m of svg.matchAll(PATH_DATA_ATTR)) {
        if ((m[1] ?? m[2] ?? '').length > limit) return true;
    }
    return false;
}

/**
 * SVG starts the dash pattern of a `<circle>` / `<ellipse>` at (cx + rx, cy) and runs clockwise.
 * svgo's `convertArcs` rewrites them into paths starting elsewhere, which shifts every dash; keep
 * them as elements (the converter emits them in the SVG direction) whenever dashes may be involved.
 */
const MAY_DASH = /stroke-dasharray/;

/**
 * `pathLength` rescales the dash pattern. svgo follows SVG 1.1, where only `<path>` accepts it:
 * `removeUnknownsAndDefaults` strips it from `<rect>`, `<circle>`… (dashes 1 unit long instead of
 * the authored fraction of the perimeter), and `mergePaths` joins paths that each carry it (the
 * scale then uses the length of the merged path).
 */
const MAY_HAVE_PATH_LENGTH = /\spathLength\s*=/;

/**
 * A negative `width` / `height` / `r` / `rx` / `ry` is an error that disables rendering of the
 * shape (the converter skips it with `empty-path`), but svgo's `convertShapeToPath` turns it into
 * a path that gets drawn. Keep the shapes as elements whenever such a value may be present.
 */
const MAY_HAVE_NEGATIVE_SIZE = /\s(?:width|height|r|rx|ry)\s*=\s*["']\s*-/;

/**
 * A zero `width` / `height` (rect), `r` (circle) or `rx` / `ry` (ellipse) also disables rendering.
 * svgo's `removeHiddenElems` deletes such shapes silently, whereas `optimize: false` reports them
 * with `empty-path` (and `strict` throws). Keep them as elements so both modes warn alike.
 * A zero in any unit counts (`cleanupNumericValues` rewrites `0mm` as `0` before `removeHiddenElems`),
 * and so does an empty or blank value: an invalid length, read as 0 by the converter and the
 * browsers, from which `convertShapeToPath` would build a degenerate path that gets stroked.
 * Element-aware so that the common `<rect rx="0">` does not match.
 */
const MAY_HAVE_ZERO_SIZE =
    /<(?:rect\b[^>]*?\s(?:width|height)|circle\b[^>]*?\sr|ellipse\b[^>]*?\sr[xy])\s*=\s*["']\s*(?:[-+]?(?:0+\.?0*|\.0+)(?:e[-+]?\d+)?(?:[a-z]+|%)?)?\s*["']/i;
/**
 * `convertShapeToPath` reads a missing `r` (circle) or a missing or empty `rx` / `ry` (ellipse) as 0.
 * For a circle that is the right size (not rendered), but the bare `M cx cy` path it emits is drawn
 * without any warning. For an ellipse the radius is `auto` (SVG 2) and takes the other one: the
 * converter draws a circle, svgo a flat ellipse. Keep such shapes as elements.
 */
const MAY_LACK_RADIUS =
    /<(?:circle\b(?![^>]*\sr\s*=)|ellipse\b(?![^>]*\srx\s*=)|ellipse\b(?![^>]*\sry\s*=)|ellipse\b[^>]*?\sr[xy]\s*=\s*(["'])\s*\1)/i;
/**
 * svgo's `convertShapeToPath` builds the path from the geometry attributes alone, ignoring the CSS
 * geometry properties (`cx`, `cy`, `r`, `rx`, `ry`, `x`, `y`, `width`, `height`) that override them
 * (`<circle r="5" style="r:0">` would be drawn). Keep the shapes as elements whenever one may be set
 * from CSS (`style` attribute or `<style>` rule); the converter resolves the cascade. The CSS `d`
 * property too: it applies to `<path>` only, so a shape turned into a path would take it
 * (`<rect style="d:path('…')">` drawn as that path). `convertEllipseToCircle` likewise reads the
 * `rx` / `ry` attributes alone: `<ellipse rx="2" ry="2" style="rx:10">` would become a `<circle>`,
 * which has no `rx`, and be drawn with r=2.
 */
const MAY_HAVE_CSS_GEOMETRY = /(?<![\w-])(?:c[xy]|r[xy]?|[xy]|width|height|d)\s*:/i;
/**
 * The CSS `d` property overrides the `d` attribute `mergePaths` joins: two paths with the same
 * `style="d:path('…')"` become one drawn once (a translucent paint then differs).
 */
const MAY_HAVE_CSS_PATH_DATA = /(?<![\w-])d\s*:/i;
const ZERO_SIZE_HIDDEN_ELEMS = {
    rectWidth0: false,
    rectHeight0: false,
    circleR0: false,
    ellipseRX0: false,
    ellipseRY0: false,
};

/**
 * A `<path>` without (or with an empty) `d`, a `<polyline>` / `<polygon>` without `points` or with
 * fewer than two points draws nothing either: `optimize: false` reports it with `empty-path`, while
 * svgo deletes it silently (`removeHiddenElems` for a missing `d` / `points` or an empty `d`,
 * `convertShapeToPath` for fewer than four coordinates). Keep them so both modes warn alike.
 */
const MAY_HAVE_EMPTY_GEOMETRY =
    /<(?:path\b(?![^>]*\sd\s*=)|path\b[^>]*?\sd\s*=\s*(["'])\1|poly(?:line|gon)\b(?![^>]*\spoints\s*=)|poly(?:line|gon)\b[^>]*?\spoints\s*=\s*(["'])\s*(?:[^\s,"']+[\s,]*){0,3}\2)/i;
const EMPTY_GEOMETRY_HIDDEN_ELEMS = { pathEmptyD: false, polylineEmptyPoints: false, polygonEmptyPoints: false };

/**
 * A `d` in error (SVG 2 §9.5.4) is rendered up to its last valid segment; the converter cuts it
 * (`validPathData`) and reports with `empty-path` one that draws nothing. svgo parses it the same
 * way, but `removeHiddenElems` deletes a path of 0 or 1 command silently (`d=" "`, `"M10 10 L"`),
 * and `mergePaths` joins a path in error with the next one, whose segments are then dropped with
 * the invalid tail (`d="M0 0 L5 5 Z 10 10"` followed by a rect: the rect disappears).
 */
function hasPathDataInError(svg: string): boolean {
    for (const m of svg.matchAll(PATH_DATA_ATTR)) {
        const d = m[1] ?? m[2] ?? '';
        if (validPathData(d) !== d) return true;
    }
    return false;
}

/**
 * svgo reads an exponent without digits as part of the number (`1e 5` → `1 5`) where SVG 2 stops
 * the path there: in `M0 0 L1e 5 9 5` it would draw two segments, where the converter and the
 * browsers draw none. Cut each `d` in error to its valid prefix (as the converter does) before svgo
 * runs, or empty it when nothing drawable remains (reported with `empty-path`). svgo has already
 * decoded character references at this point.
 */
const cutPathDataInError = {
    name: 'svgvd-cut-path-data-in-error',
    fn: () => ({
        element: {
            enter: (node: { name: string; attributes: Record<string, string> }) => {
                const { d } = node.attributes;
                if (node.name !== 'path' || d === undefined) return;
                const valid = validPathData(d) ?? '';
                if (valid !== d) node.attributes.d = valid;
            },
        },
    }),
};

const POINTS_ATTR = /<poly(?:line|gon)\b[^>]*?\spoints\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/**
 * A `points` list in error draws nothing in the browsers and in the converter (`parsePoints`), and
 * one with an odd count drops its last coordinate; svgo's `convertShapeToPath` skips the bad tokens
 * instead (`0 0 10 0 x 10 10 0 10` → a full square) and loses the `z` of an odd-count polygon. True
 * when some list draws nothing (fewer than two points) though svgo could read it otherwise: such an
 * element is kept, like {@link MAY_HAVE_EMPTY_GEOMETRY}, so both modes report it with `empty-path`.
 * Read on the source text, where an undecoded character reference makes the list look in error
 * (a false positive only keeps the element for the converter).
 */
function hasPointsDrawingNothing(svg: string): boolean {
    for (const m of svg.matchAll(POINTS_ATTR)) {
        if (parsePoints(m[1] ?? m[2] ?? '').length < 4) return true;
    }
    return false;
}

/**
 * Rewrites each `points` to the coordinates it draws ({@link parsePoints}) before svgo runs: emptied
 * when in error, its odd trailing coordinate dropped, so `convertShapeToPath` draws what the browsers
 * draw. svgo has already decoded character references at this point.
 */
const normalizePoints = {
    name: 'svgvd-normalize-points',
    fn: () => ({
        element: {
            enter: (node: { name: string; attributes: Record<string, string> }) => {
                const { points } = node.attributes;
                if ((node.name !== 'polyline' && node.name !== 'polygon') || points === undefined) return;
                const drawn = parsePoints(points).join(' ');
                if (drawn !== points) node.attributes.points = drawn;
            },
        },
    }),
};

/**
 * svgo's `removeEmptyAttrs` drops an empty `width` / `height` on `<use>`, which then falls back to
 * the referenced `<symbol>`'s own size (scaled to it), whereas `optimize: false` reports the
 * invalid value. Keep empty attributes whenever a `<use>` may carry such a value.
 */
const MAY_HAVE_EMPTY_USE_SIZE = /<use\b[^>]*?\s(?:width|height)\s*=\s*(["'])\s*\1/i;

/**
 * svgo's `convertColors` rounds each `rgb()` percentage to an integer channel before the converter
 * sees it (`rgb(20% 50% 50%)` → `#337f7f` instead of `#338080`), whereas the converter keeps the
 * fractional channel until the final rounding. Keep such colors as authored.
 */
const MAY_HAVE_RGB_PERCENT = /rgb\([^)]*%/i;

/**
 * svgo follows SVG 1.1, where `<symbol>` has no `x` / `y` / `width` / `height`:
 * `removeUnknownsAndDefaults` strips them, so a symbol without viewBox loses the viewport it is
 * clipped to (SVG 2). svgo cannot keep attributes per element, so keep the unknown ones throughout.
 */
const MAY_HAVE_SYMBOL_GEOMETRY = /<symbol\b[^>]*?\s(?:x|y|width|height)\s*=/;

/**
 * svgo moves `transform` between groups and their children (`moveElemsAttrsToGroup`,
 * `moveGroupAttrsToElems`, `collapseGroups`) and bakes it into path data (`convertPathData`)
 * without reading the CSS `transform`, `translate`, `rotate`, `scale` properties nor `transform-origin`,
 * which the converter folds into the attribute after svgo (`applyCssProperties`);
 * `removeNonInheritableGroupAttrs` drops
 * `transform-origin` from groups. Keep the transforms where they are authored when one may be set.
 * convert.ts reuses it to warn when a custom `svgoConfig` runs such a plugin.
 */
export const MAY_HAVE_CSS_TRANSFORM = /(?<![\w-])(?:transform|translate|rotate|scale)\s*:|transform-(?:origin|box)/;

/**
 * A CSS basic shape in `clip-path` (`inset()`, `circle()`, `ellipse()`, `polygon()`) is laid out on the
 * element's reference box in its own user space: svgo only keeps the transform of an element clipped by
 * a `url()`, and would bake it into the geometry (changing the box). Same guard as a CSS transform.
 */
const MAY_HAVE_CLIP_SHAPE = /clip-path\s*[:=]\s*["']?\s*(?:[a-z-]+\s+)?(?:inset|circle|ellipse|polygon)\(/i;

const CLIP_PATH_OR_USE_TAG = /<(\/?)(?:[\w.-]+:)?(clipPath|use)\b/g;

/**
 * A `<use>` in a `<clipPath>` contributes only when it references a shape or a text: one of a
 * `<g>` clips nothing (CSS Masking 1 §6.1). svgo's `collapseGroups` dissolves a `<g>` with a single
 * child and moves its id onto that child, so the `<use>` would then reference a shape and clip.
 * The other plugins keep the kind of an id'd element (`convertShapeToPath` turns a shape into a
 * path, `moveElemsAttrsToGroup` / `moveGroupAttrsToElems` move attributes only). Single linear scan:
 * a self-closing `<clipPath/>` keeps the scan "inside" until the next `</clipPath>` (over-matching
 * only costs the optimization).
 */
function mayHaveUseInClipPath(svg: string): boolean {
    if (!svg.includes('clipPath') || !svg.includes('<use')) return false;
    const tag = new RegExp(CLIP_PATH_OR_USE_TAG);
    let inside = false;
    for (let m = tag.exec(svg); m; m = tag.exec(svg)) {
        if (m[2] === 'clipPath') inside = m[1] === '';
        else if (inside && m[1] === '') return true;
    }
    return false;
}

/**
 * svgo's `removeHiddenElems` deletes a `visibility: hidden` element unless a descendant carries the
 * `visibility="visible"` attribute: a descendant made visible by a CSS declaration (`style` attribute
 * or `<style>` rule) is deleted with it, whereas `optimize: false` draws it. Keep hidden elements
 * (the converter resolves the cascade) whenever visibility may be set from CSS.
 */
const MAY_HAVE_CSS_VISIBILITY = /(?<![\w-])visibility\s*:/i;

/**
 * A relative `font-size` (`em`, `%`, `smaller` / `larger`) resolves against the parent's font-size,
 * which svgo does not track: `collapseGroups` dissolves a `<g font-size>` around a child with its
 * own relative size (the reference is lost), and `moveElemsAttrsToGroup` hoists the children's
 * relative size over the group's. Only `<text>` reads font-size (the `fonts` option): keep the
 * groups as authored when a relative size may meet text.
 */
const MAY_HAVE_TEXT = /<(?:[\w.-]+:)?text[\s/>]/;
const MAY_HAVE_RELATIVE_FONT_SIZE = /font-size\s*[:=]\s*["']?\s*(?:[+-]?[\d.]+(?:e[+-]?\d+)?(?:em|%)|smaller|larger)/i;

/**
 * `removeUnknownsAndDefaults` strips `mix-blend-mode` and `isolation` from a `<tspan>` as unknown
 * attributes, whatever the value: `<tspan mix-blend-mode="multiply">` would be drawn without the blend
 * and no warning. Kept, the converter reports the `<tspan>` as in `optimize: false`.
 */
const MAY_HAVE_TSPAN_BLENDING = /<(?:[\w.-]+:)?tspan\b(?:[^>"']|"[^"]*"|'[^']*')*?\s(?:mix-blend-mode|isolation)\s*=/;

/**
 * An unusable `fill` / `stroke` (`env()`, `var()`, a typo…) is ignored by the converter, which then
 * applies the inherited value (see `isUsablePaint`). svgo treats it as a regular value:
 * `collapseGroups` and `moveGroupAttrsToElems` push the group's paint down onto a child whose own
 * (invalid) value overrides it, and `moveElemsAttrsToGroup` hoists the children's invalid value over
 * the group's: the value to fall back to is gone before the converter runs. Keep the groups as
 * authored whenever such a value is present.
 */
const PAINT_ATTR = /(?<![\w-])(?:fill|stroke)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const PAINT_DECLARATION = /(?<![\w-])(?:fill|stroke)\s*:\s*([^;}"'<]*)/gi;
const IMPORTANT = /\s*!\s*important\s*$/i;

/** true when some `fill` / `stroke` attribute or CSS declaration holds a value the converter ignores. */
function hasUnusablePaint(svg: string): boolean {
    for (const m of svg.matchAll(PAINT_ATTR)) {
        if (!isUsablePaint(m[1] ?? m[2] ?? '')) return true;
    }
    for (const m of svg.matchAll(PAINT_DECLARATION)) {
        if (!isUsablePaint((m[1] ?? '').replace(IMPORTANT, ''))) return true;
    }
    return false;
}

/** A numeric character reference (`&#45;`, `&#x2D;`). */
const NUMERIC_REFERENCE = /&#(?:x([\da-f]+)|(\d+));/gi;
/** Left encoded: decoding them could end an attribute or a tag early in the guards' text. */
const MARKUP_CHARS = new Set(['"', "'", '<', '>', '&']);

/**
 * The guards below read the raw source, where `width="&#45;5"` is `width="-5"` to svgo. Decode
 * numeric character references once so that they see what svgo parses (named entities other
 * than the markup ones need a DTD and are left as they are).
 */
function decodeNumericReferences(svg: string): string {
    if (!svg.includes('&#')) return svg;
    return svg.replace(NUMERIC_REFERENCE, (ref: string, hex?: string, dec?: string) => {
        const code = hex === undefined ? Number(dec) : parseInt(hex, 16);
        if (code > 0x10ffff) return ref;
        const char = String.fromCodePoint(code);
        return MARKUP_CHARS.has(char) ? ref : char;
    });
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
/** A prefixed namespace declaration (`xmlns:ns0="…"`). */
const NS_DECLARATION = /(?<![^\s])xmlns:([^\s=:/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/**
 * The tokens {@link prepareSource} rewrites: comments, CDATA sections, processing instructions and
 * the doctype are matched only to be skipped (references are not decoded there); then a start or
 * end tag (quoted values may hold a `>`), or a numeric character reference in text.
 */
const SOURCE_TOKEN =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>|<(\/?)([^\s/>!?]+)((?:[^>"']|"[^"]*"|'[^']*')*)>|&#(?:x([\da-f]+)|(\d+));/gi;
/** An attribute of a start tag: its name and what follows up to the value. */
const TAG_ATTRIBUTE = /(\s)([^\s=/>]+)(\s*=\s*(?:"[^"]*"|'[^']*'))/g;
/** Left encoded by {@link prepareSource}: whitespace keeps its line / column for error positions. */
const PARSE_KEPT_CHARS = new Set([...MARKUP_CHARS, '\t', '\n', '\r']);

/** XML `Char` production: other code points make a reference invalid (left for the parser to reject). */
const isXmlChar = (c: number): boolean =>
    c === 0x9 ||
    c === 0xa ||
    c === 0xd ||
    (c >= 0x20 && c <= 0xd7ff) ||
    (c >= 0xe000 && c <= 0xfffd) ||
    (c >= 0x10000 && c <= 0x10ffff);

/** The character a numeric reference stands for, or the reference itself when it stays encoded. */
function decodedReference(ref: string, hex: string | undefined, dec: string | undefined): string {
    const code = hex === undefined ? Number(dec) : parseInt(hex, 16);
    if (!isXmlChar(code)) return ref;
    const char = String.fromCodePoint(code);
    return PARSE_KEPT_CHARS.has(char) ? ref : char;
}

/** true when an attribute of some tag of `svg` is named with `prefix` (`ns0:foo="…"`). */
function usesAttributePrefix(svg: string, prefix: string): boolean {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\s${escaped}:[^\\s=/>]+\\s*=`).test(svg);
}

/** Prefixes declared in `svg` whose every binding is `uri` (other than the reserved `xml` / `xmlns`). */
function prefixesBoundOnlyTo(svg: string, uri: string): Set<string> {
    const bound = new Set<string>();
    const elsewhere = new Set<string>();
    for (const [, prefix = '', double, single] of svg.matchAll(NS_DECLARATION)) {
        if (prefix === 'xml' || prefix === 'xmlns') continue;
        ((double ?? single) === uri ? bound : elsewhere).add(prefix);
    }
    for (const prefix of elsewhere) bound.delete(prefix);
    return bound;
}

/**
 * Rewrites the source into what svgo's parser (sax) and the converter read the same way as a browser:
 * - numeric character references are decoded (outside comments, CDATA, processing instructions and
 *   the doctype): sax counts each one as an entity and rejects a document past 512 (`&#xe9;` in an
 *   accented text, a FontForge font), which the lite parser does not. Decoded, the parser gets the
 *   same characters; the markup ones and whitespace stay encoded, like invalid references;
 * - elements whose prefix is bound to the SVG namespace (`<ns0:svg xmlns:ns0="…/2000/svg">`, written
 *   by Python's ElementTree) lose the prefix: the converter matches elements by local name and would
 *   find no `<svg>` root. Its declaration goes, replaced by a default `xmlns` when the element has
 *   none (so a namespace-aware reader, resvg, still finds SVG elements). Prefixed attributes are left
 *   as they are (in the SVG namespace, they are no presentation attributes), and so are the
 *   declarations they need;
 * - attributes whose prefix is bound to the XLink namespace under another name (`xl:href`) are
 *   renamed `xlink:…`, with their declaration.
 * A prefix bound to another namespace anywhere in the document is left alone (its elements stay
 * foreign). Without references nor such prefixes the source is returned as is.
 */
export function prepareSource(svg: string): string {
    const hasPrefixes = svg.includes('xmlns:');
    const svgPrefixes = hasPrefixes ? prefixesBoundOnlyTo(svg, SVG_NS) : new Set<string>();
    const xlinkAliases = hasPrefixes ? prefixesBoundOnlyTo(svg, XLINK_NS) : new Set<string>();
    xlinkAliases.delete('xlink');
    if (!svg.includes('&#') && svgPrefixes.size === 0 && xlinkAliases.size === 0) return svg;

    // A declaration of an SVG prefix is dropped once no attribute uses the prefix (an unbound prefix
    // would make a namespace-aware parser, resvg, reject the document).
    const droppedPrefixes = new Set([...svgPrefixes].filter((prefix) => !usesAttributePrefix(svg, prefix)));

    const localName = (name: string): string => {
        const colon = name.indexOf(':');
        return colon > 0 && svgPrefixes.has(name.slice(0, colon)) ? name.slice(colon + 1) : name;
    };
    const renameAttribute = (name: string, declaresXlink: boolean): string | undefined => {
        const colon = name.indexOf(':');
        if (colon <= 0) return name;
        const prefix = name.slice(0, colon);
        if (prefix === 'xmlns' && droppedPrefixes.has(name.slice(colon + 1))) return undefined;
        if (prefix === 'xmlns' && xlinkAliases.has(name.slice(colon + 1)))
            return declaresXlink ? undefined : 'xmlns:xlink';
        return xlinkAliases.has(prefix) ? `xlink${name.slice(colon)}` : name;
    };
    return svg.replace(
        SOURCE_TOKEN,
        (token: string, slash?: string, name?: string, attrs?: string, hex?: string, dec?: string) => {
            if (name === undefined) return token.startsWith('&') ? decodedReference(token, hex, dec) : token;
            const declaresXlink = /\sxmlns:xlink\s*=/.test(attrs!);
            let droppedSvgDeclaration = false;
            const rewritten = attrs!.replace(
                TAG_ATTRIBUTE,
                (_attr: string, space: string, attrName: string, rest: string) => {
                    if (attrName.startsWith('xmlns:') && droppedPrefixes.has(attrName.slice(6)))
                        droppedSvgDeclaration = true;
                    const renamed = renameAttribute(attrName, declaresXlink);
                    return renamed === undefined
                        ? ''
                        : `${space}${renamed}${rest.replace(NUMERIC_REFERENCE, decodedReference)}`;
                },
            );
            // The unprefixed element is in the SVG namespace only with a default declaration.
            const defaultNs = droppedSvgDeclaration && !/\sxmlns\s*=/.test(attrs!) ? ` xmlns="${SVG_NS}"` : '';
            return `<${slash}${localName(name)}${defaultNs}${rewritten}>`;
        },
    );
}

/** svgo's own default `floatPrecision`: up to it, svgo's rounding is left exactly as it is. */
const SVGO_FLOAT_PRECISION = 3;
/** Above it, svgo's path and transform rounding falls back to `Math.round` (integers). */
const SVGO_MAX_FLOAT_PRECISION = 19;
/** svgo keeps scale / matrix factors 2 decimals finer than coordinates (5 vs 3 by default). */
const TRANSFORM_EXTRA_PRECISION = 2;

/** Where {@link stashIds} keeps each `id` while svgo runs (a `data-*` attribute svgo leaves alone). */
const ID_STASH = 'data-svgvd-id';

type IdPluginNode = { type: string; attributes?: Record<string, string> };

/**
 * `inlineStyles` deletes the `id` of an element an `#id` rule was inlined into, and the preset's
 * `removeUselessDefs` then deletes that element from `<defs>` (a `<use>` or a `url(#…)` pointing
 * at it finds nothing). {@link INLINE_STYLES_KEEPING_IDS} runs `inlineStyles` on its own before the
 * preset, between {@link stashIds} (the id copied aside) and {@link restoreIds} (put back), so that
 * referenced and named (`preserveIds`) elements keep their id; the preset's own pass finds nothing
 * left to inline.
 */
const stashIds = {
    name: 'svgvd-stash-ids',
    fn: () => ({
        element: {
            enter: (node: IdPluginNode) => {
                const id = node.attributes?.id;
                if (id !== undefined) node.attributes![ID_STASH] = id;
            },
        },
    }),
};

const restoreIds = {
    name: 'svgvd-restore-ids',
    fn: () => ({
        element: {
            enter: (node: IdPluginNode) => {
                const attrs = node.attributes;
                const id = attrs?.[ID_STASH];
                if (id === undefined) return;
                delete attrs![ID_STASH];
                attrs!.id ??= id;
            },
        },
    }),
};

const INLINE_STYLES_KEEPING_IDS = [
    stashIds,
    { name: 'inlineStyles', params: DEFAULT_OVERRIDES.inlineStyles },
    restoreIds,
];

const STYLE_ELEMENT = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;
/** A reference to an element by id: `href="#a"` (`xlink:href` too) or `url(#a)`. */
const ID_REFERENCE = /(?:(?<![\w-])href\s*=\s*["']\s*#|url\(\s*["']?\s*#)([^\s"')]+)/gi;
const ID_NAME_CHAR = /[\w-]/;

/**
 * true when an element referenced by id may also be the target of an `#id` rule of a `<style>`
 * element: the case where `inlineStyles` would delete an id still in use. Over-matching (a colour
 * `#abc` taken for an id, a rule inside a comment) only costs a separate `inlineStyles` pass.
 */
function hasStyledReference(svg: string): boolean {
    if (!svg.includes('<style')) return false;
    const css = Array.from(svg.matchAll(STYLE_ELEMENT), (m) => m[1] ?? '').join('\n');
    if (!css.includes('#')) return false;
    const ids = new Set(Array.from(svg.matchAll(ID_REFERENCE), (m) => m[1] ?? ''));
    for (const id of ids) {
        for (let at = css.indexOf(`#${id}`); at !== -1; at = css.indexOf(`#${id}`, at + 1)) {
            if (!ID_NAME_CHAR.test(css[at + id.length + 1] ?? '')) return true;
        }
    }
    return false;
}

/**
 * `preserveIds`: named elements must stay separate and where they are authored. `mergePaths` joins
 * sibling paths, `collapseGroups` dissolves groups (moving a group's id onto its only child), and
 * `moveGroupAttrsToElems` pushes a group's transform down onto its children (the named group would
 * lose the transform an AnimatedVectorDrawable animates from). `cleanupIds` deletes a repeated id
 * (its only effect with `remove` / `minify` off): the converter gives the name to the first element
 * that draws something, which may be a later one.
 */
const PRESERVE_IDS_OVERRIDES = {
    mergePaths: false,
    collapseGroups: false,
    moveGroupAttrsToElems: false,
    cleanupIds: false,
};

/**
 * An invalid transform list is ignored as a whole (the element is drawn untransformed and the
 * converter reports it), but svgo's `convertTransform` / `applyTransforms` read the valid part
 * (`translate(foo 5)` → `translate(5)`, `translate(10px 5px)` → `translate(10 5)`) and bake it.
 * {@link stashInvalidTransforms} moves such a value aside while svgo runs and
 * {@link restoreInvalidTransforms} puts it back, so the converter sees and reports it as authored.
 */
const TRANSFORM_ATTRS = ['transform', 'gradientTransform', 'patternTransform'] as const;
const TRANSFORM_STASH = 'data-svgvd-invalid-';

const TRANSFORM_ATTR = /(?<![\w-])(?:transform|gradientTransform|patternTransform)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** True when some transform attribute holds an invalid transform list. */
function hasInvalidTransform(svg: string): boolean {
    for (const m of svg.matchAll(TRANSFORM_ATTR)) {
        if (isInvalidTransform(m[1] ?? m[2] ?? '')) return true;
    }
    return false;
}

/** A CSS `transform` or `scale` declaration (`style` attribute or `<style>` rule). */
const CSS_SCALING_DECLARATION = /(?<![\w-])(transform|scale)\s*:\s*([^;}"'<]*)/gi;

/**
 * svgo rounds every number to `floatPrecision` in the user space where it is authored
 * (`cleanupNumericValues` on shape attributes and `stroke-width`, `convertPathData` on a path whose
 * transform it cannot apply, a gradient's coordinates…), before the transforms magnify it: under
 * `scale(1000)`, `x="0.0021"` becomes 0.002 and is drawn at 2 instead of 2.1. Like the converter
 * under a scaled group (`scaledContentPrecision`), svgo keeps `ceil(log10(scale))` more decimals.
 * Nesting and `<use>` references are not tracked: the scale is the product of every factor above 1
 * of the document's transforms, an upper bound of the scale any content is drawn at. 0 when no
 * transform scales up.
 */
function scaledContentDigits(svg: string): number {
    let scale = 1;
    const scaleBy = (m: Matrix | null): void => {
        const factor = m ? matrixScale(m) : 1;
        if (factor > 1) scale *= factor;
    };
    for (const m of svg.matchAll(TRANSFORM_ATTR)) scaleBy(parseTransform(m[1] ?? m[2]));
    for (const m of svg.matchAll(CSS_SCALING_DECLARATION)) {
        const value = (m[2] ?? '').replace(IMPORTANT, '');
        scaleBy(
            parseCssTransform(
                m[1]!.toLowerCase() === 'scale' ? `scale(${value.trim().split(/\s+/).join(',')})` : value,
            ),
        );
    }
    return scaledPrecision(0, scale);
}

/** The start tag of the root `<svg>` (quoted values may hold a `>`). */
const ROOT_SVG_TAG = /<(?:[\w.-]+:)?svg(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/;
const XML_ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Decimals the root viewBox → size factor adds (`rootExtraDigits`, as the converter): svgo rounds in
 * viewport units too, `0.00123` under `viewBox="0 0 0.024 0.024"` at 24 px becoming `0.001`. Read on
 * the root start tag (a `<style>` rule sizing the root is not seen); 0 when there is none or its
 * viewBox is not positive.
 */
function rootContentDigits(svg: string): number {
    const tag = ROOT_SVG_TAG.exec(svg.includes('<!--') ? svg.replace(COMMENT, '') : svg);
    if (!tag) return 0;
    const attrs: Record<string, string> = {};
    for (const m of tag[1]!.matchAll(XML_ATTR)) attrs[m[1]!] = m[2] ?? m[3]!;
    try {
        return rootExtraDigits(rootLayout(attrs));
    } catch {
        return 0;
    }
}

type AttrPluginNode = { attributes: Record<string, string> };

const stashInvalidTransforms = {
    name: 'svgvd-stash-invalid-transforms',
    fn: () => ({
        element: {
            enter: (node: AttrPluginNode) => {
                for (const attr of TRANSFORM_ATTRS) {
                    const value = node.attributes[attr];
                    if (!isInvalidTransform(value)) continue;
                    node.attributes[TRANSFORM_STASH + attr] = value!;
                    delete node.attributes[attr];
                }
            },
        },
    }),
};

/**
 * A custom `svgoConfig` can move a group's transform onto the element while its invalid value is
 * stashed (`moveGroupAttrsToElems`, `collapseGroups`): the default config disables them, a custom
 * one may not. The moved transform then goes to a new `<g>` around the element, which gets its
 * invalid value back: same drawing (outer moved transform, inner ignored one), and the converter
 * reports the invalid value as authored. Runs on exit, once the element's subtree is restored.
 */
const restoreInvalidTransforms = {
    name: 'svgvd-restore-invalid-transforms',
    fn: () => ({
        element: {
            exit: (node: AttrPluginNode, parent: { children: unknown[] }) => {
                for (const attr of TRANSFORM_ATTRS) {
                    const value = node.attributes[TRANSFORM_STASH + attr];
                    if (value === undefined) continue;
                    delete node.attributes[TRANSFORM_STASH + attr];
                    const moved = node.attributes[attr];
                    node.attributes[attr] = value;
                    // No svgo plugin moves a gradientTransform / patternTransform.
                    if (moved === undefined || attr !== 'transform') continue;
                    const wrapper = { type: 'element', name: 'g', attributes: { transform: moved }, children: [node] };
                    parent.children[parent.children.indexOf(node)] = wrapper;
                }
            },
        },
    }),
};

function defaultConfigFor(
    source: string,
    floatPrecision: number,
    fillBlackForUnfilled: boolean,
    preserveIds: boolean,
): Config {
    const svg = decodeNumericReferences(source);
    const overrides: Record<string, unknown> = { ...DEFAULT_OVERRIDES };
    if (exceedsDrawableCount(svg, MERGE_PATHS_MAX_ELEMENTS)) overrides.mergePaths = false;
    if (exceedsPathDataLength(svg, CONVERT_PATH_DATA_MAX_LENGTH)) overrides.convertPathData = false;
    if (MAY_DASH.test(svg)) {
        overrides.convertShapeToPath = { convertArcs: false };
        // cleanupNumericValues rounds a single-value `stroke-dasharray="0.0001"` to "0", which SVG
        // reads as "no dashes": the stroke would turn solid with no warning. The converter rounds
        // numeric attributes itself, so skipping the plugin only keeps the authored values.
        overrides.cleanupNumericValues = false;
        // pathLength only affects dashes here (markers are not converted).
        if (MAY_HAVE_PATH_LENGTH.test(svg)) {
            overrides.removeUnknownsAndDefaults = { unknownAttrs: false };
            overrides.mergePaths = false;
        }
    }
    if (MAY_HAVE_NEGATIVE_SIZE.test(svg)) overrides.convertShapeToPath = false;
    if (MAY_HAVE_ZERO_SIZE.test(svg)) {
        overrides.convertShapeToPath = false;
        overrides.removeHiddenElems = ZERO_SIZE_HIDDEN_ELEMS;
    }
    if (MAY_LACK_RADIUS.test(svg)) overrides.convertShapeToPath = false;
    if (MAY_HAVE_CSS_GEOMETRY.test(svg)) {
        overrides.convertShapeToPath = false;
        overrides.convertEllipseToCircle = false;
    }
    if (MAY_HAVE_CSS_PATH_DATA.test(svg)) overrides.mergePaths = false;
    if (MAY_HAVE_EMPTY_GEOMETRY.test(svg) || hasPointsDrawingNothing(svg)) {
        overrides.convertShapeToPath = false;
        overrides.removeHiddenElems = {
            ...(overrides.removeHiddenElems as object | undefined),
            ...EMPTY_GEOMETRY_HIDDEN_ELEMS,
        };
    }
    if (hasPathDataInError(svg)) {
        overrides.removeHiddenElems = { ...(overrides.removeHiddenElems as object | undefined), pathEmptyD: false };
        overrides.mergePaths = false;
    }
    if (MAY_HAVE_CSS_VISIBILITY.test(svg)) {
        overrides.removeHiddenElems = { ...(overrides.removeHiddenElems as object | undefined), isHidden: false };
    }
    if (MAY_HAVE_EMPTY_USE_SIZE.test(svg)) overrides.removeEmptyAttrs = false;
    if (MAY_HAVE_RGB_PERCENT.test(svg)) overrides.convertColors = { rgb2hex: false };
    if (MAY_HAVE_SYMBOL_GEOMETRY.test(svg) || MAY_HAVE_TSPAN_BLENDING.test(svg)) {
        overrides.removeUnknownsAndDefaults = {
            ...(overrides.removeUnknownsAndDefaults as object | undefined),
            unknownAttrs: false,
        };
    }
    if (!fillBlackForUnfilled) {
        // `removeUnknownsAndDefaults` drops `fill="#000"` (black, #000000, rgb(0,0,0) once
        // `convertColors` has run) as the SVG default; without `fillBlackForUnfilled` the converter
        // would then paint nothing. svgo cannot keep a single default, so keep them all: the other
        // ones match the converter's own defaults.
        overrides.removeUnknownsAndDefaults = {
            ...(overrides.removeUnknownsAndDefaults as object | undefined),
            defaultAttrs: false,
        };
    }
    if (MAY_HAVE_CSS_TRANSFORM.test(svg) || MAY_HAVE_CLIP_SHAPE.test(svg)) {
        overrides.moveElemsAttrsToGroup = false;
        overrides.moveGroupAttrsToElems = false;
        overrides.collapseGroups = false;
        overrides.removeNonInheritableGroupAttrs = false;
        if (overrides.convertPathData !== false)
            overrides.convertPathData = { ...DEFAULT_OVERRIDES.convertPathData, applyTransforms: false };
    }
    if (hasInvalidTransform(svg)) {
        // The stashed value must stay on its element: moving a group's transform onto it (or its
        // own marker onto a child) would leave two transforms to restore, and merged paths would
        // be reported once.
        overrides.moveElemsAttrsToGroup = false;
        overrides.moveGroupAttrsToElems = false;
        overrides.collapseGroups = false;
        overrides.mergePaths = false;
    }
    if (hasUnusablePaint(svg) || hasIgnoredPresentationValue(svg)) {
        overrides.moveElemsAttrsToGroup = false;
        overrides.moveGroupAttrsToElems = false;
        overrides.collapseGroups = false;
    }
    if (mayHaveUseInClipPath(svg)) overrides.collapseGroups = false;
    if (MAY_HAVE_TEXT.test(svg) && MAY_HAVE_RELATIVE_FONT_SIZE.test(svg)) {
        overrides.moveElemsAttrsToGroup = false;
        overrides.collapseGroups = false;
    }
    if (/<switch\b/.test(svg)) {
        // A <switch> renders one child: merging or dropping its children changes which one.
        overrides.mergePaths = false;
        overrides.removeHiddenElems = false;
    }
    if (preserveIds) Object.assign(overrides, PRESERVE_IDS_OVERRIDES);
    const params: Record<string, unknown> = { overrides };
    const svgoPrecision = floatPrecision + scaledContentDigits(svg) + rootContentDigits(svg);
    if (svgoPrecision > SVGO_FLOAT_PRECISION) {
        // The preset hands `floatPrecision` to every plugin that rounds (cleanupNumericValues,
        // convertPathData, convertTransform, convertShapeToPath, mergePaths); the transform
        // precision is a separate parameter, raised so that it stays finer than coordinates.
        const precision = Math.min(svgoPrecision, SVGO_MAX_FLOAT_PRECISION);
        const transformPrecision = precision + TRANSFORM_EXTRA_PRECISION;
        params.floatPrecision = precision;
        overrides.convertTransform = { transformPrecision };
        if (overrides.convertPathData !== false)
            overrides.convertPathData = { ...(overrides.convertPathData as object), transformPrecision };
    }
    // `convertTransform` rounds a rotate / skew angle to the significant digits of the matrix minus 2:
    // `matrix(1,0,0.5,1,0,0)` becomes `skewX(27)` instead of 26.565 (~2% of the drawing moved), and
    // the rounded angle is what later gets applied to the path or kept on the group. Keep the angle
    // decimals.
    const degPrecision = Math.min(Math.max(floatPrecision, SVGO_FLOAT_PRECISION), SVGO_MAX_FLOAT_PRECISION);
    overrides.convertTransform = { ...(overrides.convertTransform as object | undefined), degPrecision };
    const preset = { name: 'preset-default', params };
    if (preserveIds) return { plugins: [...INLINE_STYLES_KEEPING_IDS, preset] } as Config;
    return { plugins: hasStyledReference(svg) ? [...INLINE_STYLES_KEEPING_IDS, preset] : [preset] } as Config;
}

/** Prefix of the internal markers the converter sets on the tree ({@link ID_STASH}, {@link TRANSFORM_STASH}, `USE_INSTANCE_ATTR`). */
const MARKER_PREFIX = 'data-svgvd-';

/**
 * Removes the internal markers written in the source: an authored `data-svgvd-id` would become the
 * element's `id` under `preserveIds`, an authored `data-svgvd-use-instance` would turn a plain `<g>`
 * into a `<use>` instance (a context element for `context-fill`). Runs first, before any svgo config.
 */
const stripMarkers = {
    name: 'svgvd-strip-markers',
    fn: () => ({
        element: {
            enter: (node: { attributes: Record<string, string> }) => {
                for (const name of Object.keys(node.attributes)) {
                    if (name.startsWith(MARKER_PREFIX)) delete node.attributes[name];
                }
            },
        },
    }),
};

/**
 * Parses (and optionally normalizes) an SVG string into svgo's AST, reusing svgo as the XML
 * parser — no third-party parser needed. The capture plugin grabs the tree in the same pass.
 * `floatPrecision`, `fillBlackForUnfilled` and `preserveIds` only tune the default svgo config; a
 * caller-supplied `svgoConfig` is used as-is.
 */
export function parseSvg(
    svg: string,
    optimizeFlag: boolean,
    svgoConfig?: Config,
    floatPrecision = SVGO_FLOAT_PRECISION,
    fillBlackForUnfilled = true,
    preserveIds = false,
): XastRoot {
    const source = prepareSource(svg);
    let captured: XastRoot | null = null;
    const capture = {
        name: 'svgvd-capture',
        fn: (root: unknown) => {
            captured = root as XastRoot;
            return {};
        },
    };

    const base = optimizeFlag
        ? (svgoConfig ?? defaultConfigFor(source, floatPrecision, fillBlackForUnfilled, preserveIds))
        : { plugins: [] };
    // svgo's minifyStyles (csso) merges repeated declarations keeping the last one, even when it is
    // invalid (`fill-rule:evenodd;fill-rule:bogus` → `fill-rule:bogus`): resolve each inline `style`
    // first, so it holds only the declarations that apply. Runs before a custom svgoConfig too.
    const cascadeStyles = {
        name: 'svgvd-cascade-styles',
        fn: () => ({
            element: {
                enter: (node: { attributes: Record<string, string> }) => {
                    const { style } = node.attributes;
                    if (style === undefined) return;
                    const cascaded = cascadedStyle(style);
                    if (cascaded) node.attributes.style = cascaded;
                    else delete node.attributes.style;
                },
            },
        }),
    };
    const plugins = [
        stripMarkers,
        ...(optimizeFlag ? [cascadeStyles, stashInvalidTransforms, cutPathDataInError, normalizePoints] : []),
        ...(base.plugins ?? []),
        ...(optimizeFlag ? [restoreInvalidTransforms] : []),
        capture,
    ] as Config['plugins'];

    try {
        optimize(source, { ...base, plugins });
    } catch (err) {
        // An internal failure (a bug, here or in svgo) is not the document's fault: let it surface.
        if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) throw err;
        throw new Error(`Invalid SVG: ${(err as Error).message}`, { cause: err });
    }
    if (!captured) throw new Error('Failed to parse SVG: empty document');
    return captured;
}
